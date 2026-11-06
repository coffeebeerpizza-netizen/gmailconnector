#!/usr/bin/env node
// Menu bar widget for SwiftBar (free macOS app: https://swiftbar.app).
//   npm run menubar -- --install    set it up (then pick the folder it prints in SwiftBar)
// SwiftBar runs this every 10 minutes and shows what it prints.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOME } from "./config.js";
import { fetchAll } from "./mail.js";
import { DEFAULT_PORT } from "./dashboard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(HOME, "menubar");
// SwiftBar menu text can't contain "|" (it separates options) or newlines.
const clean = (s, n = 60) => {
  const t = String(s ?? "").replace(/\|/g, "│").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const shq = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;

export async function render({ gmailFor } = {}) {
  const node = process.execPath;
  const dashboard = path.join(here, "dashboard.js");
  const digest = path.join(here, "digest.js");
  let data;
  try {
    data = await fetchAll({ query: "is:starred is:unread", max: 300, gmailFor });
  } catch (e) {
    console.log("✉︎ !\n---\n" + clean(e.message, 120));
    return;
  }
  const msgs = data.messages;
  const people = msgs.filter((m) => m.category === "Conversations");
  const lines = [];
  lines.push(people.length ? `✉︎ ${msgs.length} · ${people.length}👤` : msgs.length ? `✉︎ ${msgs.length}` : "✉︎");
  lines.push("---");
  lines.push(`${msgs.length} starred & unread | size=13`);
  for (const a of data.accounts) {
    const n = msgs.filter((m) => m.account === a.email).length;
    lines.push(`${clean(a.label)}: ${n} | size=12 color=gray href=https://mail.google.com/mail/?authuser=${encodeURIComponent(a.email)}#search/is%3Astarred+is%3Aunread`);
  }
  for (const e of data.errors) lines.push(`⚠︎ ${clean(e, 90)} | color=red`);
  lines.push("---");
  lines.push(`Waiting on you (${people.length})`);
  for (const m of people.slice(0, 12)) {
    lines.push(`--${clean(m.senderName, 24)}: ${clean(m.subject, 50)} | href=${m.link}`);
  }
  if (!people.length) lines.push("--Nobody right now 🎉");
  lines.push("Groups");
  for (const cat of data.categories) {
    const items = msgs.filter((m) => m.category === cat);
    if (!items.length || cat === "Conversations") continue;
    lines.push(`--${cat} (${items.length})`);
    for (const m of items.slice(0, 10)) lines.push(`----${clean(m.senderName, 24)}: ${clean(m.subject, 50)} | href=${m.link}`);
  }
  lines.push("---");
  lines.push(`Open dashboard | bash=${shq(node)} param1=${shq(dashboard)} terminal=false`);
  lines.push(`Email me the digest now | bash=${shq(node)} param1=${shq(digest)} terminal=false`);
  lines.push("Refresh | refresh=true");
  lines.push(`Dashboard address: 127.0.0.1:${DEFAULT_PORT} | size=11 color=gray`);
  console.log(lines.join("\n"));
}

function install() {
  if (process.platform !== "darwin") throw new Error("The menu bar widget is for macOS.");
  fs.mkdirSync(PLUGIN_DIR, { recursive: true, mode: 0o700 });
  const plugin = path.join(PLUGIN_DIR, "gmail.10m.sh");
  fs.writeFileSync(plugin,
    `#!/bin/bash\n# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>\n` +
    `# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>\n` +
    `exec ${shq(process.execPath)} ${shq(fileURLToPath(import.meta.url))}\n`, { mode: 0o755 });
  // Point SwiftBar at this folder (takes effect next time SwiftBar starts).
  try { execFileSync("defaults", ["write", "com.ameba.SwiftBar", "PluginDirectory", PLUGIN_DIR]); } catch {}
  const hasApp = ["/Applications/SwiftBar.app", path.join(os.homedir(), "Applications", "SwiftBar.app")].some(fs.existsSync);
  console.log(`Menu bar widget installed in:\n  ${PLUGIN_DIR}\n`);
  if (!hasApp) {
    console.log("Next, install SwiftBar (free), which shows it in your menu bar:\n  brew install --cask swiftbar\n" +
      "or download it from https://swiftbar.app\n");
  }
  console.log("Then open SwiftBar. If it asks for a plugin folder, choose the folder above\n" +
    "(press Cmd+Shift+. in the folder picker to see hidden folders).");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (process.argv[2] === "--install" ? async () => install() : () => render())()
    .catch((e) => { console.log(`✉︎ !\n---\n${clean(e.message, 120)}`); process.exitCode = 1; });
}
