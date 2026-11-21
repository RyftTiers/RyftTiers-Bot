// TEMPORARY — /transferstats
// One-off admin tool for moving a player's stats from an old Discord account
// to their new one (first use: jwwouldlos3 -> nahidlos3). Delete this file,
// its entry in commands.js and its handler in index.js once it's no longer
// needed.
//
// What moves from the source account's players row to the destination's:
//   - tiers (player_tiers): source tier wins for any gamemode both have
//   - cooldowns: the later of the two is kept
//   - coins and bank balance: added onto the destination's
//   - extra queue slots (max of the two, capped at 2) and VIP purchase
//   - test history: tests they took (test_log.player_id) and tests they ran
//     as tester (test_log.tester_id)
// The handler in index.js also copies the old account's Discord roles over
// (it keeps them on the old account too).
// The source keeps its row and Minecraft name, but ends up with no tiers,
// no cooldowns, 0 coins and 0 bank.

const { supabase, ensurePlayerForDiscordUser, invalidateVerifiedCache } = require("./supabase");

async function must(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

async function loadSnapshot(playerId) {
  const [row, tiers, cooldowns, testsTaken, testsRun] = await Promise.all([
    must(supabase.from("players").select("*").eq("id", playerId).single()),
    must(supabase.from("player_tiers").select("gamemode, tier, updated_at").eq("player_id", playerId)),
    must(supabase.from("cooldowns").select("gamemode, until").eq("player_id", playerId)),
    supabase.from("test_log").select("id", { count: "exact", head: true }).eq("player_id", playerId),
    supabase.from("test_log").select("id", { count: "exact", head: true }).eq("tester_id", playerId),
  ]);
  if (testsTaken.error) throw testsTaken.error;
  if (testsRun.error) throw testsRun.error;
  return {
    row,
    tiers,
    cooldowns,
    testsTaken: testsTaken.count || 0,
    testsRun: testsRun.count || 0,
  };
}

// Returns { source, dest, plan } without changing anything.
async function previewTransfer(fromUser, toUser) {
  const { data: srcRow, error } = await supabase
    .from("players")
    .select("id")
    .eq("discord_id", fromUser.id)
    .maybeSingle();
  if (error) throw error;
  if (!srcRow) return { error: `<@${fromUser.id}> has no player record, so there is nothing to transfer.` };

  const destRow = await ensurePlayerForDiscordUser(toUser.id, toUser.username);
  if (destRow.id === srcRow.id) return { error: "Source and destination are the same player record." };

  const source = await loadSnapshot(srcRow.id);
  const dest = await loadSnapshot(destRow.id);
  return { source, dest };
}

function describe(source, dest) {
  const s = source.row;
  const destTiers = Object.fromEntries(dest.tiers.map((t) => [t.gamemode, t.tier]));
  const tierLines = source.tiers.length
    ? source.tiers.map((t) => {
        const before = destTiers[t.gamemode];
        return `• ${t.gamemode}: **${t.tier}**${before && before !== t.tier ? ` (replaces ${before})` : ""}`;
      })
    : ["• none"];
  const lines = [
    `**From:** ${s.username} (<@${s.discord_id}>)`,
    `**To:** ${dest.row.username} (<@${dest.row.discord_id}>)`,
    "",
    "**Tiers**",
    ...tierLines,
    `**Cooldowns:** ${source.cooldowns.length ? source.cooldowns.map((c) => c.gamemode).join(", ") : "none"}`,
    `**Coins:** ${s.coins || 0} (destination ${dest.row.coins || 0} → ${(dest.row.coins || 0) + (s.coins || 0)})`,
    `**Bank:** ${s.bank_balance || 0} (destination ${dest.row.bank_balance || 0} → ${(dest.row.bank_balance || 0) + (s.bank_balance || 0)})`,
    `**Extra queue slots:** ${s.extra_queue_slots || 0}`,
    `**VIP purchased:** ${s.vip_role_purchased ? "yes" : "no"}`,
    `**Tests taken (history):** ${source.testsTaken}`,
    `**Tests run as tester:** ${source.testsRun}`,
  ];
  return lines.join("\n");
}

async function runTransfer(source, dest) {
  const srcId = source.row.id;
  const destId = dest.row.id;

  // Tiers: source wins on overlap.
  if (source.tiers.length) {
    await must(
      supabase.from("player_tiers").upsert(
        source.tiers.map((t) => ({ player_id: destId, gamemode: t.gamemode, tier: t.tier, updated_at: t.updated_at })),
        { onConflict: "player_id,gamemode" }
      )
    );
    await must(supabase.from("player_tiers").delete().eq("player_id", srcId));
  }

  // Cooldowns: keep whichever ends later.
  if (source.cooldowns.length) {
    const destCd = Object.fromEntries(dest.cooldowns.map((c) => [c.gamemode, c.until]));
    const rows = source.cooldowns.map((c) => {
      const other = destCd[c.gamemode];
      const until = other && new Date(other) > new Date(c.until) ? other : c.until;
      return { player_id: destId, gamemode: c.gamemode, until };
    });
    await must(supabase.from("cooldowns").upsert(rows, { onConflict: "player_id,gamemode" }));
    await must(supabase.from("cooldowns").delete().eq("player_id", srcId));
  }

  // Test history.
  await must(supabase.from("test_log").update({ player_id: destId }).eq("player_id", srcId));
  await must(supabase.from("test_log").update({ tester_id: destId }).eq("tester_id", srcId));

  // Economy.
  const s = source.row;
  const d = dest.row;
  await must(
    supabase
      .from("players")
      .update({
        coins: (d.coins || 0) + (s.coins || 0),
        bank_balance: (d.bank_balance || 0) + (s.bank_balance || 0),
        extra_queue_slots: Math.min(2, Math.max(d.extra_queue_slots || 0, s.extra_queue_slots || 0)),
        vip_role_purchased: !!(d.vip_role_purchased || s.vip_role_purchased),
      })
      .eq("id", destId)
  );
  await must(supabase.from("players").update({ coins: 0, bank_balance: 0 }).eq("id", srcId));

  if (s.discord_id) invalidateVerifiedCache(s.discord_id);
  if (d.discord_id) invalidateVerifiedCache(d.discord_id);
}

module.exports = { previewTransfer, runTransfer, describe };
