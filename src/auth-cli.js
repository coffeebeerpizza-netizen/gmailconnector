#!/usr/bin/env node
// Manage connected accounts:
//   node src/auth-cli.js add [alias]      sign in to a Gmail account in your browser
//   node src/auth-cli.js list             show connected accounts
//   node src/auth-cli.js remove <email|alias>
//   node src/auth-cli.js default <email|alias>
//   node src/auth-cli.js alias <email|alias> <new-alias>
import http from "node:http";
import { exec } from "node:child_process";
import { OAuth2Client } from "google-auth-library";
import { gmail as gmailApi } from "@googleapis/gmail";
import {
  SCOPES, ACCOUNTS_PATH, loadClientCredentials, loadAccounts, saveAccounts, resolveAccount, describe,
} from "./config.js";

const [cmd, ...args] = process.argv.slice(2);

function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${opener} "${url}"`, () => {});
}

async function addAccount(alias) {
  const { clientId, clientSecret } = loadClientCredentials();

  // Loopback flow: Google redirects back to a temporary local server.
  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account", // always return a refresh token, always show the account chooser
    scope: SCOPES,
  });

  console.log("\nOpening your browser to sign in. If it doesn't open, visit:\n\n" + authUrl + "\n");
  openBrowser(authUrl);

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for sign-in (5 min).")), 300_000);
    server.on("request", (req, res) => {
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (!code && !error) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(error
        ? `<h2>Sign-in failed: ${error}</h2>You can close this tab.`
        : "<h2>Account connected.</h2>You can close this tab and return to the terminal.");
      clearTimeout(timer);
      error ? reject(new Error(`Google returned: ${error}`)) : resolve(code);
    });
  }).finally(() => server.close());

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token. Try again.");
  client.setCredentials(tokens);

  const profile = await gmailApi({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress;

  const data = loadAccounts();
  const existing = data.accounts[email];
  data.accounts[email] = {
    email,
    alias: alias || existing?.alias || null,
    refresh_token: tokens.refresh_token,
    added_at: existing?.added_at || new Date().toISOString(),
  };
  if (!data.default) data.default = email;
  saveAccounts(data);

  console.log(`${existing ? "Re-authorized" : "Connected"} ${describe(data.accounts[email])}.`);
  console.log(`Saved to ${ACCOUNTS_PATH}. Restart Claude to pick it up.`);
}

function list() {
  const data = loadAccounts();
  const accts = Object.values(data.accounts);
  if (!accts.length) return console.log("No accounts yet. Run: npm run add-account");
  for (const a of accts) console.log(`${a.email === data.default ? "*" : " "} ${describe(a)}`);
  console.log("\n* = default account");
}

function pick(data, key) {
  if (!key) throw new Error("Name the account (email or alias). See: node src/auth-cli.js list");
  return resolveAccount(data, key);
}

async function main() {
  const data = loadAccounts();
  switch (cmd) {
    case "add":
      return addAccount(args[0]);
    case "list":
      return list();
    case "remove": {
      const a = pick(data, args[0]);
      delete data.accounts[a.email];
      if (data.default === a.email) data.default = Object.keys(data.accounts)[0] || null;
      saveAccounts(data);
      console.log(`Removed ${a.email}. To fully revoke access: https://myaccount.google.com/permissions`);
      return;
    }
    case "default": {
      const a = pick(data, args[0]);
      data.default = a.email;
      saveAccounts(data);
      return console.log(`Default account is now ${describe(a)}.`);
    }
    case "alias": {
      const a = pick(data, args[0]);
      a.alias = args[1] || null;
      saveAccounts(data);
      return console.log(`Updated: ${describe(a)}.`);
    }
    default:
      console.log(`Usage:
  node src/auth-cli.js add [alias]               connect a Gmail account (e.g. add work)
  node src/auth-cli.js list                      show connected accounts
  node src/auth-cli.js remove <email|alias>      disconnect an account
  node src/auth-cli.js default <email|alias>     account used when none is named
  node src/auth-cli.js alias <email|alias> <new> rename an account's short name`);
  }
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
