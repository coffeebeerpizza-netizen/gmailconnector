// Gmail API helpers: one authorized client per account, message parsing, MIME building.
import { OAuth2Client } from "google-auth-library";
import { gmail as gmailApi } from "@googleapis/gmail";
import { loadClientCredentials, loadAccounts, saveAccounts } from "./config.js";

const clients = new Map();

export function gmailFor(account) {
  const cached = clients.get(account.email);
  if (cached && cached.token === account.refresh_token) return cached.api;

  const { clientId, clientSecret } = loadClientCredentials();
  const auth = new OAuth2Client({ clientId, clientSecret });
  auth.setCredentials({ refresh_token: account.refresh_token });
  // Google occasionally rotates refresh tokens; persist the new one.
  auth.on("tokens", (t) => {
    if (t.refresh_token && t.refresh_token !== account.refresh_token) {
      const data = loadAccounts();
      if (data.accounts[account.email]) {
        data.accounts[account.email].refresh_token = t.refresh_token;
        saveAccounts(data);
      }
    }
  });
  const api = gmailApi({ version: "v1", auth });
  clients.set(account.email, { token: account.refresh_token, api });
  return api;
}

/** Turn a Gmail API auth failure into something actionable. */
export function explainError(err, account) {
  const msg = err?.response?.data?.error_description || err?.response?.data?.error?.message || err?.message || String(err);
  if (/invalid_grant|unauthorized_client|Token has been expired or revoked/i.test(msg)) {
    return `${account.email}: sign-in expired or was revoked. Re-run: npm run add-account` +
      (account.alias ? ` -- ${account.alias}` : "");
  }
  return `${account.email}: ${msg}`;
}

export function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decode(b64url) {
  return Buffer.from(b64url.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Walk the MIME tree: prefer text/plain, else text/html converted to text; collect attachments. */
export function extractBody(payload) {
  let plain = "", html = "";
  const attachments = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body.size });
    } else if (part.mimeType === "text/plain" && part.body?.data) {
      plain += decode(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html += decode(part.body.data);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return { text: plain.trim() || htmlToText(html), attachments };
}

export function summarize(msg, accountEmail) {
  const h = msg.payload?.headers;
  return {
    account: accountEmail,
    id: msg.id,
    threadId: msg.threadId,
    from: header(h, "From"),
    to: header(h, "To"),
    subject: header(h, "Subject"),
    date: header(h, "Date"),
    labels: msg.labelIds || [],
    unread: (msg.labelIds || []).includes("UNREAD"),
    snippet: msg.snippet,
  };
}

const encodeHeader = (s) => (/^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

/** Build a base64url RFC 2822 message. */
export function buildRaw({ from, to, cc, bcc, subject, body, html, inReplyTo, references }) {
  const lines = [`From: ${from}`, `To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${encodeHeader(subject || "")}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`);
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(Buffer.from(body || "").toString("base64").replace(/(.{76})/g, "$1\r\n"));
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

/** Headers/thread needed to send a proper reply to message `id`. */
export async function replyContext(api, id) {
  const { data } = await api.users.messages.get({
    userId: "me", id, format: "metadata",
    metadataHeaders: ["Subject", "Message-ID", "References", "From", "Reply-To"],
  });
  const h = data.payload.headers;
  const msgId = header(h, "Message-ID");
  const subject = header(h, "Subject");
  return {
    threadId: data.threadId,
    inReplyTo: msgId,
    references: [header(h, "References"), msgId].filter(Boolean).join(" "),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    replyTo: header(h, "Reply-To") || header(h, "From"),
  };
}
