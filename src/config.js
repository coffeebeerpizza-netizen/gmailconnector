// Where credentials and per-account tokens live, and how they're read/written.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = process.env.GMAIL_MCP_HOME || path.join(os.homedir(), ".gmail-multi-mcp");
export const CREDENTIALS_PATH = path.join(HOME, "credentials.json");
export const ACCOUNTS_PATH = path.join(HOME, "accounts.json");

// gmail.modify = read, compose, send, label, archive, trash (no permanent delete).
export const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

/** The OAuth client (Desktop app) downloaded from Google Cloud Console. */
export function loadClientCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `No OAuth client found at ${CREDENTIALS_PATH}. Download your Desktop-app OAuth client JSON ` +
        `from Google Cloud Console and save it there (see README).`
    );
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const c = raw.installed || raw.web || raw;
  if (!c.client_id || !c.client_secret) {
    throw new Error(`${CREDENTIALS_PATH} is missing client_id/client_secret.`);
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

/** { default: "email" | null, accounts: { [email]: { email, alias, refresh_token, added_at } } } */
export function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return { default: null, accounts: {} };
  const data = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
  data.accounts ||= {};
  data.default ??= null;
  return data;
}

export function saveAccounts(data) {
  ensureHome();
  const tmp = ACCOUNTS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_PATH);
}

/** Find an account by email or alias (case-insensitive). Falls back to the default/only account. */
export function resolveAccount(data, key) {
  const list = Object.values(data.accounts);
  if (list.length === 0) {
    throw new Error("No Gmail accounts connected yet. Run: npm run add-account");
  }
  if (!key) {
    if (data.default && data.accounts[data.default]) return data.accounts[data.default];
    if (list.length === 1) return list[0];
    throw new Error(
      `Several accounts are connected; say which one: ${list.map(describe).join(", ")}`
    );
  }
  const k = key.trim().toLowerCase();
  const byEmail = list.find((a) => a.email.toLowerCase() === k);
  if (byEmail) return byEmail;
  const hits = list.filter((a) => a.alias && a.alias.toLowerCase() === k);
  if (hits.length > 1) {
    throw new Error(
      `"${key}" is the name of more than one account (${hits.map((a) => a.email).join(", ")}). ` +
        `Use the email address, or rename one: node src/auth-cli.js alias <email> <new-name>`
    );
  }
  if (!hits.length) throw new Error(`Unknown account "${key}". Connected: ${list.map(describe).join(", ")}`);
  return hits[0];
}

export function describe(a) {
  return a.alias ? `${a.alias} (${a.email})` : a.email;
}

/** Throw if `alias` is already used by an account other than `email`. */
export function assertAliasFree(data, alias, email) {
  if (!alias) return;
  const clash = Object.values(data.accounts).find(
    (a) => a.email !== email && a.alias && a.alias.toLowerCase() === alias.toLowerCase()
  );
  if (clash) {
    throw new Error(`The name "${alias}" is already used by ${clash.email}. Pick a different name.`);
  }
}
