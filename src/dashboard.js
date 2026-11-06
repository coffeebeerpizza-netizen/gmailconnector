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
import { HOME, loadAccounts, describe } from "./config.js";
import { gmailFor as realGmailFor, explainError, header } from "./gmail.js";
import { CATEGORIES, categorize, senderEmail, senderName, unsubscribeUrl } from "./categorize.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, "..", "dashboard", "index.html");
const PREFS_PATH = path.join(HOME, "dashboard.json");

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")); } catch { return { overrides: {} }; }
}
function savePrefs(p) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2), { mode: 0o600 });
}

const ACTIONS = {
  read: { remove: ["UNREAD"] },
  unread: { add: ["UNREAD"] },
  unstar: { remove: ["STARRED"] },
  star: { add: ["STARRED"] },
  archive: { remove: ["INBOX"] },
  inbox: { add: ["INBOX"] },
};

async function fetchMessages(api, query, max) {
  const ids = [];
  let pageToken;
  do {
    const { data } = await api.users.messages.list({
      userId: "me", q: query, maxResults: Math.min(500, max - ids.length), pageToken,
    });
    ids.push(...(data.messages || []).map((m) => m.id));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < max);

  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = await Promise.all(ids.slice(i, i + 20).map((id) =>
      api.users.messages.get({
        userId: "me", id, format: "metadata",
        metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe"],
      })
    ));
    out.push(...batch.map((r) => r.data));
  }
  return out;
}

export function createDashboard({ gmailFor = realGmailFor, token = crypto.randomBytes(18).toString("base64url") } = {}) {
  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(res, 403, { error: "bad host" });
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname === "/" && req.method === "GET") {
      const html = fs.readFileSync(PAGE, "utf8").replace("__TOKEN__", token);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (req.headers["x-token"] !== token) return json(res, 401, { error: "bad token" });

    try {
      if (url.pathname === "/api/messages" && req.method === "GET") {
        const query = url.searchParams.get("q") || "is:starred";
        const max = Math.min(Number(url.searchParams.get("max")) || 500, 1000);
        const data = loadAccounts();
        const prefs = loadPrefs();
        const messages = [], errors = [];
        await Promise.all(Object.values(data.accounts).map(async (acct) => {
          try {
            const raw = await fetchMessages(gmailFor(acct), query, max);
            for (const m of raw) {
              const h = m.payload?.headers;
              const msg = {
                account: acct.email,
                accountLabel: acct.alias || acct.email,
                id: m.id,
                threadId: m.threadId,
                from: header(h, "From"),
                subject: header(h, "Subject") || "(no subject)",
                date: header(h, "Date"),
                ts: Number(m.internalDate) || Date.parse(header(h, "Date")) || 0,
                snippet: (m.snippet || "").replace(/[͏‌ \s]+/g, " ").trim(),
                labels: m.labelIds || [],
                listUnsubscribe: header(h, "List-Unsubscribe"),
              };
              msg.unread = msg.labels.includes("UNREAD");
              msg.starred = msg.labels.includes("STARRED");
              msg.category = categorize(msg, prefs.overrides);
              msg.senderEmail = senderEmail(msg.from);
              msg.senderName = senderName(msg.from);
              msg.unsubscribe = unsubscribeUrl(msg.listUnsubscribe);
              delete msg.listUnsubscribe;
              messages.push(msg);
            }
          } catch (e) {
            errors.push(explainError(e, acct));
          }
        }));
        messages.sort((a, b) => b.ts - a.ts);
        return json(res, 200, {
          query,
          accounts: Object.values(data.accounts).map((a) => ({ email: a.email, label: a.alias || a.email })),
          categories: CATEGORIES,
          messages,
          errors,
        });
      }

      if (url.pathname === "/api/modify" && req.method === "POST") {
        const { account, ids, action } = await readBody(req);
        const spec = ACTIONS[action];
        if (!spec || !Array.isArray(ids) || !ids.length) return json(res, 400, { error: "bad request" });
        const acct = loadAccounts().accounts[account];
        if (!acct) return json(res, 400, { error: `unknown account ${account}` });
        try {
          for (let i = 0; i < ids.length; i += 1000) {
            await gmailFor(acct).users.messages.batchModify({
              userId: "me",
              requestBody: { ids: ids.slice(i, i + 1000), addLabelIds: spec.add || [], removeLabelIds: spec.remove || [] },
            });
          }
        } catch (e) {
          return json(res, 502, { error: explainError(e, acct) });
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

      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  });
  return { server, token };
}

function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${opener} "${url}"`, () => {});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 8765;
  const { server } = createDashboard();
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE"
      ? `Port ${port} is busy. Is the dashboard already open? Or run: PORT=8766 npm run dashboard`
      : e.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    const accts = Object.values(loadAccounts().accounts).map(describe).join(", ") || "none";
    console.log(`Dashboard running at ${url}\nAccounts: ${accts}\nKeep this window open; press Ctrl+C to stop.`);
    if (!process.env.NO_OPEN) openBrowser(url);
  });
}
