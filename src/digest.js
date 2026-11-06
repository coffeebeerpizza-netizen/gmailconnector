#!/usr/bin/env node
// Daily digest email: what's starred & unread across all accounts, people first.
//   npm run digest                   send it now (to your default account)
//   npm run digest -- --preview      open it in your browser instead of sending
//   npm run digest -- --install 7:45 send it every day at 7:45 (macOS)
//   npm run digest -- --uninstall    stop the daily email
// Set DIGEST_TO=you@example.com to send it somewhere other than the default account.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOME, loadAccounts, resolveAccount } from "./config.js";
import { gmailFor, buildRaw } from "./gmail.js";
import { fetchAll } from "./mail.js";
import { openBrowser } from "./dashboard.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LABEL = "com.gmail-multi.digest";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function when(ts) {
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86400e3);
  if (days < 1) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export async function buildDigest({ gmailFor: g } = {}) {
  const [starred, fresh] = await Promise.all([
    fetchAll({ query: "is:starred is:unread", max: 300, gmailFor: g }),
    fetchAll({ query: "in:inbox is:unread newer_than:1d", max: 100, gmailFor: g }),
  ]);
  const people = new Map();
  for (const m of [...starred.messages, ...fresh.messages]) {
    if (m.category === "Conversations") people.set(m.id, m);
  }
  const waiting = [...people.values()].sort((a, b) => b.ts - a.ts);
  const others = starred.messages.filter((m) => m.category !== "Conversations");
  const errors = [...new Set([...starred.errors, ...fresh.errors])];

  const row = (m) => `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top">
      <a href="${m.link}" style="color:#1d1f23;text-decoration:none"><b>${esc(m.senderName)}</b> &middot; ${esc(m.subject)}</a>
      <div style="color:#6b6f76;font-size:13px;margin-top:2px">${esc(m.snippet.slice(0, 140))}</div>
    </td>
    <td style="padding:8px 0 8px 12px;border-bottom:1px solid #eee;color:#6b6f76;font-size:12px;white-space:nowrap;vertical-align:top;text-align:right">${esc(m.accountLabel)}<br>${when(m.ts)}</td>
  </tr>`;

  const groups = starred.categories.filter((c) => c !== "Conversations").map((cat) => {
    const items = others.filter((m) => m.category === cat);
    if (!items.length) return "";
    return `<h3 style="font-size:15px;margin:22px 0 4px">${esc(cat)} <span style="color:#6b6f76;font-weight:400">(${items.length})</span></h3>
      <table width="100%" cellspacing="0" cellpadding="0">${items.slice(0, 5).map(row).join("")}</table>
      ${items.length > 5 ? `<div style="color:#6b6f76;font-size:13px;margin-top:4px">+ ${items.length - 5} more</div>` : ""}`;
  }).join("");

  const perAcct = starred.accounts.map((a) =>
    `${esc(a.label)}: ${starred.messages.filter((m) => m.account === a.email).length}`).join(" &middot; ");
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const html = `<!doctype html><html><body style="margin:0;background:#f6f4ef">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1f23;font-size:15px;line-height:1.45">
    <div style="background:#fff;border:1px solid #e6e2d9;border-radius:12px;padding:20px">
      <h1 style="font-size:22px;margin:0 0 4px">Your mail, ${esc(today)}</h1>
      <div style="color:#6b6f76;font-size:14px">${starred.messages.length} starred &amp; unread &middot; ${perAcct}</div>
      ${errors.length ? `<div style="margin-top:12px;padding:10px;border:1px solid #c2410c;border-radius:8px;font-size:13px"><b>Needs attention:</b><br>${errors.map(esc).join("<br>")}</div>` : ""}
      <h2 style="font-size:17px;margin:22px 0 4px;color:#c2410c">Waiting on you (${waiting.length})</h2>
      <div style="color:#6b6f76;font-size:13px">Unread emails from people: starred ones, plus anything new in the last day.</div>
      ${waiting.length ? `<table width="100%" cellspacing="0" cellpadding="0">${waiting.slice(0, 15).map(row).join("")}</table>`
        : `<p style="color:#6b6f76">Nobody's waiting on you. 🎉</p>`}
      ${groups ? `<h2 style="font-size:17px;margin:26px 0 0">Starred reading</h2>${groups}` : ""}
      <p style="color:#6b6f76;font-size:12px;margin-top:26px">Open the dashboard to tick these off or draft replies: run <code>npm run dashboard</code> in your gmailconnector folder, or use the menu bar.</p>
    </div>
  </div></body></html>`;

  const subject = `Mail digest: ${waiting.length} waiting on you, ${starred.messages.length} starred unread`;
  return { html, subject };
}

async function send() {
  const data = loadAccounts();
  const from = resolveAccount(data);
  const to = process.env.DIGEST_TO || from.email;
  const { html, subject } = await buildDigest();
  const raw = buildRaw({ from: from.email, to, subject, body: html, html: true });
  await gmailFor(from).users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`${new Date().toISOString()} Sent "${subject}" to ${to}`);
}

async function preview() {
  const { html, subject } = await buildDigest();
  const file = path.join(HOME, "digest-preview.html");
  fs.writeFileSync(file, html, { mode: 0o600 });
  console.log(`Preview: ${subject}\nSaved to ${file}`);
  openBrowser(`file://${file}`);
}

function install(timeArg = "7:45") {
  if (process.platform !== "darwin") throw new Error("--install sets up a macOS schedule; on other systems use cron.");
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeArg);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('Give a time like 7:45 or 18:30');
  const script = fileURLToPath(import.meta.url);
  const log = path.join(HOME, "digest.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(script)}</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${+m[1]}</integer><key>Minute</key><integer>${+m[2]}</integer></dict>
  ${process.env.DIGEST_TO ? `<key>EnvironmentVariables</key><dict><key>DIGEST_TO</key><string>${esc(process.env.DIGEST_TO)}</string></dict>` : ""}
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  try { execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" }); } catch {}
  fs.writeFileSync(PLIST, plist);
  execFileSync("launchctl", ["load", "-w", PLIST]);
  console.log(`Daily digest scheduled for ${timeArg} every day. If your Mac is asleep then, it sends when it wakes.`);
  console.log(`Log: ${log}. To stop: npm run digest -- --uninstall`);
}

function uninstall() {
  try { execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" }); } catch {}
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  console.log("Daily digest turned off.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [flag, arg] = process.argv.slice(2);
  const run = flag === "--preview" ? preview
    : flag === "--install" ? async () => install(arg)
    : flag === "--uninstall" ? async () => uninstall()
    : send;
  run().catch((e) => { console.error(`${new Date().toISOString()} Error: ${e.message}`); process.exit(1); });
}
