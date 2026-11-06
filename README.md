# gmail-multi-mcp

A local MCP server that connects Claude Desktop or Claude Code to **several Gmail accounts at once**. You don't need to switch accounts: every tool takes an `account` (an email or a short alias like `work`), and search can cover all accounts together.

Everything stays on your computer. Each account's sign-in token is stored in `~/.gmail-multi-mcp/accounts.json`, which only you can read.

## Tools

| Tool | What it does |
|---|---|
| `list_accounts` | Lists connected accounts, their aliases and the default |
| `search_emails` | Searches with Gmail syntax. Use `account: "all"` to search every account |
| `read_email` / `read_thread` | Returns the full text, headers and attachment list |
| `send_email` | Sends from a chosen account. Can reply in a thread |
| `create_draft` | Saves a draft, including a reply draft |
| `update_email` | Marks read/unread, archives, stars, adds or removes labels |
| `trash_email` | Moves mail to Trash (you can recover it for 30 days) |
| `list_labels` | Lists an account's labels |

If you don't name an account, the tool uses the default account.

## One-time setup (about 10 minutes)

### 1. Create a Google OAuth client
You only need one client, and it works for all your accounts.

1. Go to <https://console.cloud.google.com/>, create a project (any name), then open **APIs & Services → Library** and enable the **Gmail API**.
2. Open **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"):
   - User type: **External**. Fill in the app name and your email.
   - Under **Data access / Scopes**, add `https://www.googleapis.com/auth/gmail.modify`.
   - Under **Audience**, click **Publish app** to move it to *In production*. Don't submit it for verification.
     > This matters: while the app is in *Testing*, Google expires its sign-ins every **7 days**. A published app keeps working. Because the app isn't verified, Google shows a warning each time you add an account. Click **Advanced → Go to (app name)**. You're the only user.
3. Open **Credentials → Create credentials → OAuth client ID**, choose **Desktop app**, then **Download JSON**.
4. Save that file as `~/.gmail-multi-mcp/credentials.json`:
   ```bash
   mkdir -p ~/.gmail-multi-mcp && mv ~/Downloads/client_secret_*.json ~/.gmail-multi-mcp/credentials.json
   ```

### 2. Install
Requires Node.js 18 or newer.
```bash
git clone https://github.com/coffeebeerpizza-netizen/gmailconnector && cd gmailconnector && npm install
```

### 3. Connect each account
Run this once per account. The optional last word is a short alias:
```bash
npm run add-account -- personal
npm run add-account -- work
```
A browser window opens, and you pick the account to connect. To see what's connected, run `npm run accounts`.

Other commands:
```bash
node src/auth-cli.js default work        # account used when none is named
node src/auth-cli.js alias b@work.com job
node src/auth-cli.js remove work
```

### 4. Add it to Claude
**Claude Desktop:** open Settings → Developer → Edit Config. Add the following to `claude_desktop_config.json`, using the full path to your clone, then restart Claude:
```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "node",
      "args": ["/full/path/to/gmailconnector/src/server.js"]
    }
  }
}
```

**Claude Code:**
```bash
claude mcp add gmail-multi --scope user -- node /full/path/to/gmailconnector/src/server.js
```

Next, try asking Claude: *"What's unread across all my accounts today?"* or *"Reply to that from my work account saying I'll be there."*

## Dashboard

A page in your browser that shows starred mail from all your accounts, grouped by kind:

```bash
npm run dashboard
```

It opens <http://127.0.0.1:8765>. Keep the Terminal window open while you use it, and press Ctrl+C to stop.

- **Groups:** Conversations (real people) come first, then AI & Tech, Food & Drink, Travel & Housing, Money & Finance, Orders & Support, News & Politics, Promotions and Other newsletters. Each group shows a count, how many are unread, and a progress bar.
- **Checkboxes:** a ticked box marks the email read in Gmail, and unticking marks it unread.
- **Group buttons:** "Mark all read" and "Unstar all" act on the whole group (or on the emails your filters show). You can undo them.
- **Move to another group:** use the "Group" menu on any email. Every email from that sender moves, and the dashboard remembers it in `~/.gmail-multi-mcp/dashboard.json`.
- **Filters:** turn accounts on or off, hide read emails, or search (press `/`). The menu at the top switches between Starred, Starred & unread, Important, and Unread inbox.
- **Links:** Open goes to the email in Gmail, and Unsubscribe appears for newsletters that offer it.

The dashboard only accepts connections from your own computer, and every request has to carry a secret key that changes each time it starts. Other websites can't use it.

## Notes
- **Scope:** `gmail.modify` lets the server read, send, label, archive and trash mail. It can't permanently delete mail.
- **Expired sign-in** (e.g. you changed your password or revoked access): the tool tells you which account. Re-run `npm run add-account -- <alias>`.
- **Revoke access:** run `remove`, then remove the app at <https://myaccount.google.com/permissions>.
- **Built-in Gmail connector:** if Claude's built-in Gmail connector is also on, turn it off for chats where you use this one, so Claude doesn't pick the wrong tool.
- Set `GMAIL_MCP_HOME` to keep tokens somewhere other than `~/.gmail-multi-mcp`.
