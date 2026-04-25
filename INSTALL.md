# Installing Halseth

> **Tech-savvy?** The quick version is in [README.md](./README.md). This guide is for everyone else.

## What is Halseth, in plain English?

Halseth is a data store for your companion system. It holds session history, emotional state, tasks, and other companion memory — and exposes it to Claude via an MCP connection.

It runs on **Cloudflare Workers** — Cloudflare's serverless platform. You don't need your own server. It stays online 24/7 for free, hosted on Cloudflare's global infrastructure. Think of it like a tiny always-on app that Cloudflare runs for you.

**There is no "local computer" option for production.** You can run it locally for testing, but it won't persist data properly. The real deployment goes to Cloudflare.

---

## What you need before starting

- **A Cloudflare account** (free) — [cloudflare.com](https://cloudflare.com)
- **Node.js** installed on your computer — [nodejs.org](https://nodejs.org) — get the **LTS** version
- **Git** — [git-scm.com](https://git-scm.com)
- A terminal open. On Windows: search "Terminal" or "PowerShell" in the Start menu. On Mac: Spotlight → Terminal.

---

## Step 1 — Install Wrangler (Cloudflare's command-line tool)

```bash
npm install -g wrangler
wrangler login
```

A browser window will open — click Allow. This connects your terminal to your Cloudflare account.

---

## Step 2 — Get the code

```bash
git clone https://github.com/neurospicyexe/halseth.git
cd halseth
npm install
```

---

## Step 3 — Create Cloudflare resources

Run these one at a time. After the first command, **copy the `database_id`** from the output — you'll need it in Step 4.

```bash
wrangler d1 create halseth
wrangler r2 bucket create halseth-artifacts
wrangler vectorize create halseth-memories --dimensions=768 --metric=cosine
```

---

## Step 4 — Configure

```bash
cp wrangler.toml wrangler.prod.toml
```

Open `wrangler.prod.toml` in any text editor. Fill in:

- `database_id = ""` → paste the ID from Step 3
- `SYSTEM_OWNER = ""` → your name, lowercase (e.g. `"alex"`)

Save the file. Do not commit it — it's already gitignored.

---

## Step 5 — Set up the database

```bash
npm run migrate:remote
```

This creates all the tables. You'll see a list of SQL files — that's normal.

---

## Step 6 — Set your secrets

Secrets are passwords stored securely in Cloudflare — not in any file on disk.

```bash
wrangler secret put ADMIN_SECRET --config wrangler.prod.toml
wrangler secret put MCP_AUTH_SECRET --config wrangler.prod.toml
```

Type a long random password at each prompt. **Save both in a password manager** — you'll need them to connect Claude and other parts of the suite.

---

## Step 7 — Deploy

```bash
npm run deploy
```

At the end you'll see a URL like `halseth.neurospicyexe.workers.dev`. That's your Halseth instance.

---

## Step 8 — Bootstrap

One-time setup call to initialize companion data:

```bash
curl -X POST https://halseth.neurospicyexe.workers.dev/admin/bootstrap \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
```

Replace `YOUR_ADMIN_SECRET` with the password from Step 6.

---

## Connecting Claude

Add this to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "Halseth": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://halseth.neurospicyexe.workers.dev/mcp"],
      "env": { "MCP_AUTH_TOKEN": "YOUR_MCP_AUTH_SECRET" }
    }
  }
}
```

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `7403` on migrations | Your Cloudflare API token is missing D1 Edit permission. Go to Cloudflare → My Profile → API Tokens → edit the token → add D1:Edit |
| `Missing script: deploy` | Run `npm install` first |
| `Not found` on bootstrap | Check the URL — make sure deploy completed successfully |
| Blank page in Claude | Check that MCP_AUTH_SECRET matches between Cloudflare secrets and your Claude config |
