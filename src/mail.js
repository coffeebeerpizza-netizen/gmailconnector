// Shared mail-fetching used by the dashboard, the daily digest and the menu bar widget.
import fs from "node:fs";
import path from "node:path";
import { HOME, loadAccounts } from "./config.js";
import { gmailFor as realGmailFor, explainError, header, extractBody } from "./gmail.js";
import { CATEGORIES, categorize, senderEmail, senderName, unsubscribeUrl } from "./categorize.js";

export { CATEGORIES };
export const PREFS_PATH = path.join(HOME, "dashboard.json");

export function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")); } catch { return { overrides: {} }; }
}
export function savePrefs(p) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2), { mode: 0o600 });
}

export const gmailLink = (account, threadId) =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${threadId}`;

async function listIds(api, query, max) {
  const ids = [];
  let pageToken;
  do {
    const { data } = await api.users.messages.list({
      userId: "me", q: query, maxResults: Math.min(500, max - ids.length), pageToken,
    });
    ids.push(...(data.messages || []).map((m) => m.id));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

function enrich(m, acct, prefs) {
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
    snippet: (m.snippet || "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
      .replace(/[͏‌ \s]+/g, " ").trim(),
    labels: m.labelIds || [],
    listUnsubscribe: header(h, "List-Unsubscribe"),
  };
  msg.unread = msg.labels.includes("UNREAD");
  msg.starred = msg.labels.includes("STARRED");
  msg.category = categorize(msg, prefs.overrides);
  msg.senderEmail = senderEmail(msg.from);
  msg.senderName = senderName(msg.from);
  msg.unsubscribe = unsubscribeUrl(msg.listUnsubscribe);
  msg.link = gmailLink(msg.account, msg.threadId);
  delete msg.listUnsubscribe;
  return msg;
}

/** Fetch and categorize matching mail from every connected account. */
export async function fetchAll({ query = "is:starred", max = 500, gmailFor } = {}) {
  gmailFor ||= realGmailFor;
  const data = loadAccounts();
  const prefs = loadPrefs();
  const messages = [], errors = [];
  await Promise.all(Object.values(data.accounts).map(async (acct) => {
    try {
      const api = gmailFor(acct);
      const ids = await listIds(api, query, max);
      for (let i = 0; i < ids.length; i += 20) {
        const batch = await Promise.all(ids.slice(i, i + 20).map((id) =>
          api.users.messages.get({
            userId: "me", id, format: "metadata",
            metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe"],
          })
        ));
        messages.push(...batch.map((r) => enrich(r.data, acct, prefs)));
      }
    } catch (e) {
      errors.push(explainError(e, acct));
    }
  }));
  messages.sort((a, b) => b.ts - a.ts);
  return {
    query,
    accounts: Object.values(data.accounts).map((a) => ({ email: a.email, label: a.alias || a.email })),
    defaultAccount: data.default,
    categories: CATEGORIES,
    messages,
    errors,
  };
}

/** Plain-text transcript of a thread (newest last), trimmed for an AI prompt. */
export async function threadTranscript(api, threadId, { maxMessages = 8, maxChars = 3000 } = {}) {
  const { data } = await api.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const msgs = (data.messages || []).slice(-maxMessages);
  return msgs.map((m) => {
    const h = m.payload?.headers;
    let { text } = extractBody(m.payload);
    // Drop quoted history ("On ... wrote:" and "> " lines) to keep it short.
    text = text.split(/\n(?:On .{5,200}wrote:|-{2,}\s*Original Message|From: .+\nSent: )/)[0]
      .split("\n").filter((l) => !l.startsWith(">")).join("\n").trim();
    if (text.length > maxChars) text = text.slice(0, maxChars) + " […]";
    return `From: ${header(h, "From")}\nDate: ${header(h, "Date")}\nSubject: ${header(h, "Subject")}\n\n${text}`;
  }).join("\n\n---\n\n");
}
