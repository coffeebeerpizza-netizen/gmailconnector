#!/usr/bin/env node
// Local web dashboard for starred (or any) mail across all connected accounts.
//   npm run dashboard            -> opens http://127.0.0.1:8765
// Only listens on 127.0.0.1, and every API call needs a random token that's
// generated at startup and embedded in the page, so other websites can't use it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAccounts, describe } from "./config.js";
import { gmailFor as realGmailFor, explainError, buildRaw, replyContext } from "./gmail.js";
import { CATEGORIES, fetchAll, loadPrefs, savePrefs, threadTranscript } from "./mail.js";
import { askClaude as realAskClaude, REPLY_SYSTEM } from "./claude.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, "..", "dashboard", "index.html");
export const DEFAULT_PORT = 8765;

const ACTIONS = {
  read: { remove: ["UNREAD"] },
  unread: { add: ["UNREAD"] },
  unstar: { remove: ["STARRED"] },
  star: { add: ["STARRED"] },
  archive: { remove: ["INBOX"] },
  inbox: { add: ["INBOX"] },
};

export function createDashboard({
  gmailFor = realGmailFor,
  askClaude = realAskClaude,
  token = crypto.randomBytes(18).toString("base64url"),
} = {}) {
  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
  const accountFor = (email) => {
    const acct = loadAccounts().accounts[email];
    if (!acct) throw Object.assign(new Error(`unknown account ${email}`), { status: 400 });
    return acct;
  };

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(res, 403, { error: "bad host" });
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname === "/" && req.method === "GET") {
      const html = fs.readFileSync(PAGE, "utf8").replace("__TOKEN__", token);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    if (url.pathname === "/ping") return json(res, 200, { app: "gmail-multi-dashboard" });
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (req.headers["x-token"] !== token) return json(res, 401, { error: "bad token" });

    let acct;
    try {
      if (url.pathname === "/api/messages" && req.method === "GET") {
        const query = url.searchParams.get("q") || "is:starred";
        const max = Math.min(Number(url.searchParams.get("max")) || 500, 1000);
        return json(res, 200, await fetchAll({ query, max, gmailFor }));
      }

      if (url.pathname === "/api/modify" && req.method === "POST") {
        const { account, ids, action } = await readBody(req);
        const spec = ACTIONS[action];
        if (!spec || !Array.isArray(ids) || !ids.length) return json(res, 400, { error: "bad request" });
        acct = accountFor(account);
        for (let i = 0; i < ids.length; i += 1000) {
          await gmailFor(acct).users.messages.batchModify({
            userId: "me",
            requestBody: { ids: ids.slice(i, i + 1000), addLabelIds: spec.add || [], removeLabelIds: spec.remove || [] },
          });
        }
        return json(res, 200, { ok: true });
      }

      if (url.pathname === "/api/category" && req.method === "POST") {
        const { sender, category } = await readBody(req);
        if (!sender || (category && !CATEGORIES.includes(category))) return json(res, 400, { error: "bad request" });
        const prefs = loadPrefs();
        prefs.overrides ||= {};
        if (category) prefs.overrides[sender.toLowerCase()] = category;
        else delete prefs.overrides[sender.toLowerCase()];
        savePrefs(prefs);
        return json(res, 200, { ok: true });
      }

      // Ask Claude for a reply draft. Returns text only; nothing is saved or sent.
      if (url.pathname === "/api/draft" && req.method === "POST") {
        const { account, threadId, instructions } = await readBody(req);
        acct = accountFor(account);
        const transcript = await threadTranscript(gmailFor(acct), threadId);
        const prompt =
          `I am ${acct.email}. Draft my reply to the latest message in this thread.\n` +
          (instructions ? `What I want to say: ${String(instructions).slice(0, 1000)}\n` : "") +
          `\n<thread>\n${transcript}\n</thread>`;
        const text = await askClaude({ system: REPLY_SYSTEM, prompt });
        return json(res, 200, { text });
      }

      // Save edited text as a Gmail draft reply in the same thread (not sent).
      if (url.pathname === "/api/save-draft" && req.method === "POST") {
        const { account, id, body } = await readBody(req);
        if (!body || !id) return json(res, 400, { error: "bad request" });
        acct = accountFor(account);
        const api = gmailFor(acct);
        const ctx = await replyContext(api, id);
        const raw = buildRaw({
          from: acct.email, to: ctx.replyTo, subject: ctx.subject, body,
          inReplyTo: ctx.inReplyTo, references: ctx.references,
        });
        const { data } = await api.users.drafts.create({
          userId: "me", requestBody: { message: { raw, threadId: ctx.threadId } },
        });
        return json(res, 200, {
          ok: true, draftId: data.id, to: ctx.replyTo,
          link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(acct.email)}#drafts`,
        });
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, e.status || (acct ? 502 : 500), { error: acct ? explainError(e, acct) : e.message });
    }
  });
  return { server, token };
}

export function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${opener} "${url}"`, () => {});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}/`;
  const { server } = createDashboard();
  server.on("error", async (e) => {
    if (e.code === "EADDRINUSE") {
      // Already running (e.g. started from the menu bar)? Just open it.
      const ok = await fetch(url + "ping").then((r) => r.json()).then((j) => j.app === "gmail-multi-dashboard").catch(() => false);
      if (ok) { console.log(`Dashboard is already running at ${url}, so I opened it.`); if (!process.env.NO_OPEN) openBrowser(url); process.exit(0); }
      console.error(`Port ${port} is used by another program. Run: PORT=8766 npm run dashboard`);
    } else console.error(e.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const accts = Object.values(loadAccounts().accounts).map(describe).join(", ") || "none";
    console.log(`Dashboard running at ${url}\nAccounts: ${accts}\nKeep this window open; press Ctrl+C to stop.`);
    if (!process.env.NO_OPEN) openBrowser(url);
  });
}
