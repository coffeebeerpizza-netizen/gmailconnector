#!/usr/bin/env node
// MCP server (stdio) exposing several Gmail accounts to Claude through one connector.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadAccounts, resolveAccount, describe } from "./config.js";
import { gmailFor, explainError, extractBody, summarize, buildRaw, replyContext, header } from "./gmail.js";

const server = new McpServer({ name: "gmail-multi", version: "1.0.0" });

const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

const accountArg = z
  .string()
  .optional()
  .describe("Email address or alias of the account to use. Omit to use the default account.");

/** Resolve the account fresh each call so accounts added with the CLI show up without a restart. */
function account(key) {
  return resolveAccount(loadAccounts(), key);
}

async function run(key, fn) {
  let acct;
  try {
    acct = account(key);
    return ok(await fn(gmailFor(acct), acct));
  } catch (e) {
    return fail(acct ? explainError(e, acct) : e.message);
  }
}

server.registerTool(
  "list_accounts",
  {
    description: "List the Gmail accounts connected to this server, with their aliases and which is the default.",
    inputSchema: {},
  },
  async () => {
    const data = loadAccounts();
    return ok(Object.values(data.accounts).map((a) => ({
      email: a.email, alias: a.alias, default: a.email === data.default,
    })));
  }
);

server.registerTool(
  "search_emails",
  {
    description:
      "Search mail with Gmail search syntax (e.g. 'is:unread newer_than:2d', 'from:bob subject:invoice'). " +
      "Set account to 'all' to search every connected account at once; results say which account each came from.",
    inputSchema: {
      query: z.string().default("in:inbox").describe("Gmail search query"),
      account: z.string().optional().describe("Email or alias, or 'all' for every account. Omit for the default account."),
      max_results: z.number().int().min(1).max(50).default(10).describe("Per account"),
    },
  },
  async ({ query, account: key, max_results }) => {
    const data = loadAccounts();
    let targets;
    try {
      targets = key?.toLowerCase() === "all" ? Object.values(data.accounts) : [resolveAccount(data, key)];
    } catch (e) {
      return fail(e.message);
    }
    if (!targets.length) return fail("No Gmail accounts connected yet. Run: npm run add-account");

    const results = [], errors = [];
    await Promise.all(targets.map(async (acct) => {
      try {
        const api = gmailFor(acct);
        const { data: list } = await api.users.messages.list({ userId: "me", q: query, maxResults: max_results });
        const msgs = await Promise.all((list.messages || []).map((m) =>
          api.users.messages.get({
            userId: "me", id: m.id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"],
          })
        ));
        results.push(...msgs.map((r) => summarize(r.data, acct.email)));
      } catch (e) {
        errors.push(explainError(e, acct));
      }
    }));
    results.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    return ok(errors.length ? { results, errors } : results);
  }
);

server.registerTool(
  "read_email",
  {
    description: "Read one email's full text, headers and attachment list.",
    inputSchema: { message_id: z.string(), account: accountArg },
  },
  ({ message_id, account: key }) =>
    run(key, async (api, acct) => {
      const { data } = await api.users.messages.get({ userId: "me", id: message_id, format: "full" });
      const { text, attachments } = extractBody(data.payload);
      return { ...summarize(data, acct.email), cc: header(data.payload.headers, "Cc"), body: text, attachments };
    })
);

server.registerTool(
  "read_thread",
  {
    description: "Read every message in a conversation thread, oldest first.",
    inputSchema: { thread_id: z.string(), account: accountArg },
  },
  ({ thread_id, account: key }) =>
    run(key, async (api, acct) => {
      const { data } = await api.users.threads.get({ userId: "me", id: thread_id, format: "full" });
      return (data.messages || []).map((m) => {
        const { text, attachments } = extractBody(m.payload);
        return { ...summarize(m, acct.email), body: text, attachments };
      });
    })
);

const composeArgs = {
  account: accountArg,
  to: z.string().optional().describe("Comma-separated recipients. Optional when replying (defaults to the original sender)."),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional().describe("Optional when replying (defaults to 'Re: <original subject>')."),
  body: z.string(),
  html: z.boolean().default(false).describe("Treat body as HTML"),
  reply_to_message_id: z.string().optional().describe("Message ID to reply to; keeps the reply in the same thread."),
};

async function compose(api, acct, args) {
  let threadId, ctx = {};
  if (args.reply_to_message_id) {
    const r = await replyContext(api, args.reply_to_message_id);
    threadId = r.threadId;
    ctx = { inReplyTo: r.inReplyTo, references: r.references };
    args = { ...args, to: args.to || r.replyTo, subject: args.subject || r.subject };
  }
  if (!args.to) throw new Error("'to' is required unless replying.");
  const raw = buildRaw({ ...args, ...ctx, from: acct.email });
  return { raw, threadId };
}

server.registerTool(
  "send_email",
  {
    description:
      "Send an email from a specific connected account. Always confirm the sending account, recipients and text with the user before calling.",
    inputSchema: composeArgs,
  },
  (args) =>
    run(args.account, async (api, acct) => {
      const requestBody = await compose(api, acct, args);
      const { data } = await api.users.messages.send({ userId: "me", requestBody });
      return { sent: true, from: acct.email, id: data.id, threadId: data.threadId };
    })
);

server.registerTool(
  "create_draft",
  {
    description: "Save a draft in a specific account (not sent). Supports replies via reply_to_message_id.",
    inputSchema: composeArgs,
  },
  (args) =>
    run(args.account, async (api, acct) => {
      const message = await compose(api, acct, args);
      const { data } = await api.users.drafts.create({ userId: "me", requestBody: { message } });
      return { drafted: true, account: acct.email, draftId: data.id, messageId: data.message?.id };
    })
);

server.registerTool(
  "update_email",
  {
    description:
      "Change an email's state: mark read/unread, archive, move back to inbox, star, or add/remove labels (by name or ID).",
    inputSchema: {
      message_id: z.string(),
      account: accountArg,
      mark_read: z.boolean().optional(),
      archive: z.boolean().optional().describe("true removes from Inbox; false moves back to Inbox"),
      star: z.boolean().optional(),
      add_labels: z.array(z.string()).optional(),
      remove_labels: z.array(z.string()).optional(),
    },
  },
  (args) =>
    run(args.account, async (api, acct) => {
      const add = new Set(), remove = new Set();
      if (args.mark_read !== undefined) (args.mark_read ? remove : add).add("UNREAD");
      if (args.archive !== undefined) (args.archive ? remove : add).add("INBOX");
      if (args.star !== undefined) (args.star ? add : remove).add("STARRED");

      if (args.add_labels?.length || args.remove_labels?.length) {
        const { data } = await api.users.labels.list({ userId: "me" });
        const byName = new Map(data.labels.map((l) => [l.name.toLowerCase(), l.id]));
        const ids = new Set(data.labels.map((l) => l.id));
        const toId = (n) => {
          if (ids.has(n)) return n;
          const id = byName.get(n.toLowerCase());
          if (!id) throw new Error(`No label named "${n}" in ${acct.email}.`);
          return id;
        };
        (args.add_labels || []).forEach((n) => add.add(toId(n)));
        (args.remove_labels || []).forEach((n) => remove.add(toId(n)));
      }
      if (!add.size && !remove.size) throw new Error("Nothing to change.");
      const { data } = await api.users.messages.modify({
        userId: "me", id: args.message_id,
        requestBody: { addLabelIds: [...add], removeLabelIds: [...remove] },
      });
      return { account: acct.email, id: data.id, labels: data.labelIds };
    })
);

server.registerTool(
  "trash_email",
  {
    description: "Move an email to Trash (recoverable for 30 days).",
    inputSchema: { message_id: z.string(), account: accountArg },
  },
  ({ message_id, account: key }) =>
    run(key, async (api, acct) => {
      await api.users.messages.trash({ userId: "me", id: message_id });
      return { trashed: true, account: acct.email, id: message_id };
    })
);

server.registerTool(
  "list_labels",
  {
    description: "List the labels in an account.",
    inputSchema: { account: accountArg },
  },
  ({ account: key }) =>
    run(key, async (api) => {
      const { data } = await api.users.labels.list({ userId: "me" });
      return data.labels.map((l) => ({ id: l.id, name: l.name, type: l.type }));
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
const n = Object.keys(loadAccounts().accounts).length;
console.error(`gmail-multi MCP server running with ${n} account(s): ${Object.values(loadAccounts().accounts).map(describe).join(", ") || "none"}`);
