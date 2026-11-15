// Stops cracked (offline-mode) players from verifying under a name that
// belongs to a real, paid Minecraft account.
//
// On an offline-mode server anyone can join as any name, and their UUID is
// derived from the name alone: UUID v3 of "OfflinePlayer:<name>". A premium
// account's UUID is the one Mojang issued, which is different. So when a
// player says they're cracked but the name they picked is registered with
// Mojang, it's someone else's account and the verification is refused.
const https = require("https");
const crypto = require("crypto");

const MOJANG_PROFILE_URL = "https://api.mojang.com/users/profiles/minecraft/";

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, body });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/** Adds dashes to a 32-char hex UUID. */
function dashUUID(hex) {
  const h = String(hex).replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The UUID an offline-mode server gives a player with this name: an MD5
 * (v3) UUID of "OfflinePlayer:<name>", same as Java's
 * UUID.nameUUIDFromBytes(). Case-sensitive, like the server.
 */
function offlineUUID(username) {
  const md5 = crypto.createHash("md5").update(`OfflinePlayer:${username}`, "utf8").digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // IETF variant
  return dashUUID(md5.toString("hex"));
}

// Mojang rate-limits lookups, and the same name tends to get checked a few
// times in a row (verify, then a profile edit), so cache answers briefly.
const CACHE_TTL_MS = 10 * 60 * 1000;
const _cache = new Map(); // lowercased name -> { result, expiresAt }

/**
 * Looks a name up with Mojang.
 * Returns { status: "premium", uuid, name } when it's a paid account,
 * { status: "not_premium" } when no such account exists, or
 * { status: "unknown", error } when Mojang couldn't be reached (rate limit,
 * outage). Callers should not block anyone on "unknown".
 */
async function lookupPremiumAccount(username) {
  const key = String(username || "").toLowerCase();
  if (!key) return { status: "not_premium" };
  const hit = _cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  let result;
  try {
    const { status, body } = await httpGetJson(MOJANG_PROFILE_URL + encodeURIComponent(username));
    if (status === 200 && body && body.id) {
      result = { status: "premium", uuid: dashUUID(body.id), name: body.name || username };
    } else if (status === 204 || status === 404) {
      result = { status: "not_premium" };
    } else {
      return { status: "unknown", error: `HTTP ${status}` };
    }
  } catch (err) {
    return { status: "unknown", error: err.message };
  }
  _cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Decides whether a player may verify with this name and platform.
 * Only cracked players are checked: a cracked player's UUID is always the
 * offline one, so if Mojang has a premium account under that name the two
 * UUIDs can't match and the name isn't theirs.
 * Returns { allowed: true } or { allowed: false, reason, premiumUUID, offlineUUID }.
 */
async function checkCrackedNameAllowed(username, platform) {
  if (platform !== "cracked" || !username) return { allowed: true };
  const account = await lookupPremiumAccount(username);
  if (account.status === "unknown") {
    console.warn(`[premium-check] couldn't check "${username}" with Mojang (${account.error}); allowing`);
    return { allowed: true, unchecked: true };
  }
  if (account.status !== "premium") return { allowed: true };

  const offline = offlineUUID(username);
  if (account.uuid === offline) return { allowed: true }; // can't happen in practice
  return {
    allowed: false,
    premiumUUID: account.uuid,
    offlineUUID: offline,
    reason:
      `**${account.name}** is a premium (paid) Minecraft account, so it can't be used on a cracked account. ` +
      "If this is your account, verify again with the platform set to **Premium**. " +
      "Otherwise, verify with your own cracked username.",
  };
}

module.exports = { lookupPremiumAccount, checkCrackedNameAllowed, offlineUUID };
