// Ties each verified premium player to their Minecraft account UUID, and
// keeps their username current when they rename.
//
// Why: tools like Global Tier Tagger show RyftTiers ranks next to players
// in-game, and they match players by UUID. A username alone isn't enough:
// names can be changed and later picked up by someone else, and ranks must
// stay with the account that earned them.
//
// How:
//  - When a premium player verifies (website or Discord), the name they
//    gave is resolved with Mojang right then and the UUID is saved on their
//    players row. set_my_profile() (and setVerifiedUsername) clear the UUID
//    whenever the username or platform changes, so it's re-resolved.
//  - After that the UUID is the source of truth: a periodic job asks Mojang
//    for each saved UUID's current name and updates the row if the player
//    renamed, so their tiers follow the account, not the old name.
//  - UUIDs are only saved for verified players (with a linked Discord
//    account). Rows created by a tester typing a name are left without one
//    until that player verifies, so an old name is never guessed into
//    whoever owns it today.
//  - A UUID is unique across players. If a second row would get a UUID
//    another row already has, it's skipped and logged for staff to merge.
const { supabase } = require("./supabase");
const { lookupPremiumAccount, lookupNameByUUID } = require("./premium-check");

const RENAME_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MOJANG_GAP_MS = 2500; // stay well under Mojang's rate limits
const RETRY_UNRESOLVED_MS = 15 * 60 * 1000; // re-try lookups Mojang refused

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function needsUUID(row) {
  return (
    !!row &&
    row.platform === "premium" &&
    !!row.discord_id &&
    !!row.username &&
    !row.uuid &&
    !/^Unverified_\d+$/.test(row.username) &&
    !/^discord-\d+$/.test(row.username)
  );
}

// Resolves and saves the UUID for one players row. Safe to call on every
// players INSERT/UPDATE: it does nothing unless the row needs one, and the
// write it makes leaves a row that no longer does (so no loop).
// Resolves to "saved", "skipped", or "retry" (Mojang couldn't answer).
async function syncPlayerUUID(row) {
  if (!needsUUID(row)) return "skipped";
  const account = await lookupPremiumAccount(row.username);
  if (account.status === "unknown") {
    console.warn(`[uuid-sync] couldn't resolve "${row.username}" (${account.error}); will retry later`);
    return "retry";
  }
  if (account.status !== "premium") {
    console.log(`[uuid-sync] "${row.username}" (player ${row.id}) is not a premium account; no UUID saved`);
    return "skipped";
  }

  const { data: owner, error: ownerErr } = await supabase
    .from("players")
    .select("id, username")
    .eq("uuid", account.uuid)
    .maybeSingle();
  if (ownerErr) {
    console.error("[uuid-sync] lookup failed:", ownerErr.message);
    return "retry";
  }
  if (owner && owner.id !== row.id) {
    console.warn(
      `[uuid-sync] UUID ${account.uuid} for "${row.username}" (player ${row.id}) already belongs to ` +
      `"${owner.username}" (player ${owner.id}); not saving it twice. Staff should merge these rows.`
    );
    return "skipped";
  }

  // Save Mojang's capitalisation of the name too (same name, so the unique
  // lower-case index is unaffected). The uuid-is-null guard skips the write
  // if the row changed under us since it was read.
  const { error } = await supabase
    .from("players")
    .update({ uuid: account.uuid, username: account.name })
    .eq("id", row.id)
    .eq("username_lower", row.username.toLowerCase())
    .is("uuid", null);
  if (error) {
    console.error(`[uuid-sync] couldn't save UUID for player ${row.id}:`, error.message);
    return "retry";
  }
  console.log(`[uuid-sync] player ${row.id} "${account.name}" -> ${account.uuid}`);
  return "saved";
}

// Gives a UUID to every verified premium player who doesn't have one yet
// (players who verified before UUIDs were saved, or whose lookup failed).
// Resolves to how many lookups Mojang couldn't answer.
async function backfillMissingUUIDs() {
  const { data, error } = await supabase
    .from("players")
    .select("id, username, platform, discord_id, uuid")
    .eq("platform", "premium")
    .not("discord_id", "is", null)
    .is("uuid", null);
  if (error) {
    console.error("[uuid-sync] backfill query failed:", error.message);
    return 1;
  }
  let unresolved = 0;
  for (const row of data || []) {
    if (!needsUUID(row)) continue;
    const outcome = await syncPlayerUUID(row).catch((e) => {
      console.error("[uuid-sync] backfill:", e.message);
      return "retry";
    });
    if (outcome === "retry") unresolved++;
    await sleep(MOJANG_GAP_MS);
  }
  return unresolved;
}

// Follows renames: for each saved UUID, asks Mojang for the account's
// current name and updates the row if it changed.
async function refreshRenamedPlayers() {
  const { data, error } = await supabase
    .from("players")
    .select("id, username, uuid")
    .not("uuid", "is", null);
  if (error) {
    console.error("[uuid-sync] rename query failed:", error.message);
    return;
  }
  for (const row of data || []) {
    const res = await lookupNameByUUID(row.uuid);
    if (res.status === "found" && res.name !== row.username) {
      const { error: upErr } = await supabase
        .from("players")
        .update({ username: res.name })
        .eq("id", row.id)
        .eq("uuid", row.uuid);
      if (upErr) {
        // Usually another row already holds the new name (e.g. a tester
        // made one by typing it). Leave both as they are for staff.
        console.warn(`[uuid-sync] player ${row.id} renamed "${row.username}" -> "${res.name}" but couldn't update:`, upErr.message);
      } else {
        console.log(`[uuid-sync] player ${row.id} renamed "${row.username}" -> "${res.name}"`);
      }
    } else if (res.status === "unknown") {
      console.warn(`[uuid-sync] couldn't check ${row.uuid} (${res.error})`);
    }
    await sleep(MOJANG_GAP_MS);
  }
}

let started = false;
function startUUIDSync() {
  if (started) return;
  started = true;
  // Backfill until every lookup got an answer (Mojang often rate-limits
  // shared hosts), retrying every 15 minutes, then fall back to the 12-hour
  // cycle along with the rename check.
  const backfill = async () => {
    const unresolved = await backfillMissingUUIDs().catch((e) => {
      console.error("[uuid-sync] backfill failed:", e.message);
      return 1;
    });
    if (unresolved > 0) {
      console.log(`[uuid-sync] ${unresolved} lookup(s) unresolved; retrying in 15 minutes`);
      setTimeout(backfill, RETRY_UNRESOLVED_MS);
    }
  };
  const renames = () =>
    refreshRenamedPlayers().catch((e) => console.error("[uuid-sync] rename check failed:", e.message));
  backfill().then(renames);
  setInterval(() => backfill().then(renames), RENAME_CHECK_INTERVAL_MS);
}

module.exports = { syncPlayerUUID, backfillMissingUUIDs, refreshRenamedPlayers, startUUIDSync, needsUUID };
