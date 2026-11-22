// /ssresult — look up a ModAnzer screenshare report by its reference code.
//
// ModAnzer (github.com/RyftTiers/ModAnzer) sends a player's scan results to
// its report function in the RyftTiers Supabase project, which saves them in
// the `modanzer_reports` table and gives the player a 6-character code. The
// player gives the code to staff, and staff run
// `/ssresult refcode:<code> user:@player` here to see the report.
// The table is defined in supabase/schema.sql.

const { EmbedBuilder, AttachmentBuilder } = require("discord.js");
const { supabase } = require("./supabase");

// RyftTiers queue-card colours.
const ACCENT = 0x3fa0f5;
const EMBER = 0xf97316;
const RED = 0xef4444;
const GREEN = 0x4ade80;

const CODE_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/;

function normaliseCode(raw) {
  return String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function fetchReport(code) {
  const { data, error } = await supabase
    .from("modanzer_reports")
    .select("*")
    .eq("ref_code", code)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Records who looked at the report and which player it belongs to. The first
// staff member to open it stays in checked_by; later lookups don't overwrite it.
async function markChecked(report, staffId, playerId) {
  const patch = { status: "checked" };
  if (!report.checked_by) {
    patch.checked_by = staffId;
    patch.checked_at = new Date().toISOString();
  }
  if (playerId && !report.player_id) patch.player_id = playerId;
  const { error } = await supabase.from("modanzer_reports").update(patch).eq("id", report.id);
  if (error) console.error("[ssresult] could not mark report checked:", error.message);
}

const clip = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// Discord allows 6000 characters across all embeds in one message, so the
// longer lists get smaller caps; the attached file always has everything.
// Joins lines into one embed field value (max 1024 chars), saying how many were left out.
function fieldLines(lines, max = 1024) {
  if (!lines.length) return "None";
  const out = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    const more = `\n…and ${lines.length - i} more (see the attached file)`;
    if (len + lines[i].length + 1 + more.length > max) {
      out.push(more.trim());
      break;
    }
    out.push(lines[i]);
    len += lines[i].length + 1;
  }
  return out.join("\n");
}

const md = (s) => String(s ?? "").replace(/([*_`~|>\\])/g, "\\$1");

function alertLines(alerts) {
  const sorted = [...(alerts || [])].sort((a, b) => (a.Level === "Red" ? 0 : 1) - (b.Level === "Red" ? 0 : 1));
  return sorted.map((a) => `${a.Level === "Red" ? "🔴" : "🟠"} ${a.Time ? `\`${md(a.Time)}\` ` : ""}${md(clip(a.Text, 180))}`);
}

function verdict(r) {
  const cheats = r.mods?.Cheat || 0;
  const red = [...(r.system?.Alerts || []), ...(r.injection?.Alerts || [])].filter((a) => a.Level === "Red").length;
  const yellow = [...(r.system?.Alerts || []), ...(r.injection?.Alerts || [])].length - red;
  const unknown = r.mods?.Unknown || 0;
  if (cheats || red) return { color: RED, label: "Flagged", text: `${cheats} cheat mod(s), ${red} red alert(s)` };
  if (unknown || yellow) return { color: EMBER, label: "Worth a look", text: `${unknown} unknown mod(s), ${yellow} alert(s)` };
  return { color: GREEN, label: "Clean", text: "Nothing flagged" };
}

function toUnix(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function buildEmbeds(r, playerUser) {
  const v = verdict(r);
  const received = toUnix(r.received_at);
  const embeds = [];

  const summary = new EmbedBuilder()
    .setColor(v.color)
    .setAuthor({ name: "RyftTiers · ModAnzer" })
    .setTitle(`Screenshare result · ${r.ref_code}`)
    .setDescription(`**${v.label}** — ${v.text}`)
    .addFields(
      { name: "Player", value: playerUser ? `${playerUser}` : r.player_id ? `<@${r.player_id}>` : r.discord_id ? `<@${r.discord_id}>` : "Not given", inline: true },
      { name: "Mode", value: md(r.mode) || "Unknown", inline: true },
      { name: "Sent", value: received ? `<t:${received}:f> (<t:${received}:R>)` : md(r.finished) || "Unknown", inline: true },
      { name: "Minecraft accounts", value: fieldLines((r.accounts || []).map((a) => `\`${md(a)}\``), 300), inline: false },
    )
    .setFooter({ text: "Everything here is a lead, not proof. Check each one with the player." });
  if (r.checked_by) {
    const t = toUnix(r.checked_at);
    summary.addFields({ name: "Already looked up", value: `by <@${r.checked_by}>${t ? ` <t:${t}:R>` : ""}`, inline: false });
  }
  embeds.push(summary);

  if (r.mods) {
    const m = r.mods;
    const mods = new EmbedBuilder()
      .setColor(m.Cheat ? RED : m.Unknown ? EMBER : ACCENT)
      .setTitle("Mod Analyzer")
      .setDescription(
        `✅ Verified **${m.Verified || 0}** · 🟦 CurseForge app **${m.CurseForgeApp || 0}** · ❔ Unknown **${m.Unknown || 0}** · ⛔ Cheat **${m.Cheat || 0}**`
      )
      .addFields(
        { name: "Cheats found", value: fieldLines((m.Cheats || []).map((c) => `⛔ **${md(clip(c.Name, 80))}** — ${md(clip(c.Where, 60))}${c.Strings ? `\n  ↳ \`${clip(c.Strings, 120).replace(/`/g, "'")}\`` : ""}`)) },
        { name: "Unknown mods", value: fieldLines((m.Unknowns || []).map((u) => `❔ ${md(clip(u.Name, 80))} — ${md(clip(u.Where, 60))}`), 700) },
      );
    if ((m.Folders || []).length) mods.addFields({ name: "Folders scanned", value: fieldLines(m.Folders.map((f) => `\`${clip(f, 100).replace(/`/g, "'")}\``), 400) });
    embeds.push(mods);
  }

  if (r.injection) {
    const i = r.injection;
    const red = (i.Alerts || []).some((a) => a.Level === "Red");
    embeds.push(
      new EmbedBuilder()
        .setColor(red ? RED : (i.Alerts || []).length ? EMBER : ACCENT)
        .setTitle("Injection Checker")
        .setDescription(`Admin: **${i.Admin ? "yes" : "no"}**${i.Uptime ? ` · Game uptime: **${md(i.Uptime)}**` : ""}${i.GameFolder ? `\nGame folder: \`${clip(i.GameFolder, 150).replace(/`/g, "'")}\`` : ""}`)
        .addFields({ name: "Alerts", value: fieldLines(alertLines(i.Alerts), 750) })
    );
  }

  if (r.system) {
    const s = r.system;
    const red = (s.Alerts || []).some((a) => a.Level === "Red");
    embeds.push(
      new EmbedBuilder()
        .setColor(red ? RED : (s.Alerts || []).length ? EMBER : ACCENT)
        .setTitle("System Check")
        .setDescription(`Admin: **${s.Admin ? "yes" : "no"}**${s.Admin ? "" : " (some checks were skipped)"}`)
        .addFields({ name: "Alerts", value: fieldLines(alertLines(s.Alerts), 750) })
    );
  }

  return embeds;
}

// The full report as plain text, including every scanned mod, for the attachment.
function buildText(r) {
  const L = [];
  L.push(`ModAnzer report ${r.ref_code}`);
  L.push(`Mode: ${r.mode || "?"}   Finished: ${r.finished || "?"}   Received: ${r.received_at || "?"}`);
  L.push(`Minecraft accounts: ${(r.accounts || []).join(", ") || "none"}`);
  if (r.mods) {
    const m = r.mods;
    L.push("", "== Mod Analyzer ==");
    L.push(`Verified ${m.Verified || 0}, CurseForge app ${m.CurseForgeApp || 0}, Unknown ${m.Unknown || 0}, Cheat ${m.Cheat || 0}`);
    if ((m.Folders || []).length) L.push("Folders:", ...m.Folders.map((f) => "  " + f));
    if ((m.Cheats || []).length) L.push("Cheats:", ...m.Cheats.map((c) => `  [CHEAT] ${c.Name} (${c.Where})  ${c.Strings || ""}`));
    if ((m.Unknowns || []).length) L.push("Unknown:", ...m.Unknowns.map((u) => `  [?] ${u.Name} (${u.Where})`));
    if ((m.All || []).length) L.push("All mods:", ...m.All.map((x) => `  [${x.Status}] ${x.Name}${x.Title ? ` - ${x.Title}` : ""} (${x.Where})`));
  }
  for (const [title, part] of [["Injection Checker", r.injection], ["System Check", r.system]]) {
    if (!part) continue;
    L.push("", `== ${title} ==`, `Admin: ${part.Admin ? "yes" : "no"}`);
    if (part.Uptime) L.push(`Game uptime: ${part.Uptime}`);
    if (part.GameFolder) L.push(`Game folder: ${part.GameFolder}`);
    for (const a of part.Alerts || []) L.push(`  [${a.Level}] ${a.Time || ""} ${a.Text}`);
  }
  return L.join("\n");
}

async function handleSsResult(interaction, { isStaff }) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({ content: "Only testers and staff can look up screenshare results.", ephemeral: true });
  }
  const code = normaliseCode(interaction.options.getString("refcode", true));
  const playerUser = interaction.options.getUser("user");
  const show = interaction.options.getBoolean("show") === true;

  if (!CODE_RE.test(code)) {
    return interaction.reply({ content: "That doesn't look like a ModAnzer code. Codes are 6 letters and numbers, like `7k3qxf`.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: !show });
  try {
    const report = await fetchReport(code);
    if (!report) {
      return interaction.editReply({ content: `No report found for \`${code}\`. Check the code with the player; it's shown at the end of the scan.` });
    }
    const embeds = buildEmbeds(report, playerUser);
    const file = new AttachmentBuilder(Buffer.from(buildText(report), "utf8"), { name: `modanzer-${code}.txt` });
    await interaction.editReply({ embeds: embeds.slice(0, 10), files: [file] });
    await markChecked(report, interaction.user.id, playerUser?.id);
  } catch (err) {
    console.error("[ssresult] failed:", err.message);
    await interaction.editReply({ content: "Something went wrong looking that report up. Try again in a moment." });
  }
}

module.exports = { handleSsResult, buildEmbeds, buildText, normaliseCode };
