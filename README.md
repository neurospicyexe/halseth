# Halseth

The data backbone for the Nullsafe companion system. A personal memory and coordination server that runs on Cloudflare's free tier — stores companion sessions, relational history, tasks, routines, biometrics, and more.

---

> **⚠️ Disclaimer**
> This project was built with AI assistance ("vibe-coded"). Security hardening has been applied to the best of our ability — OAuth, input validation, parameterized queries, secret management — but this software comes with **no warranty and no liability**. It has not undergone a professional security audit. If you use it, you use it at your own risk. Not recommended for storing sensitive data in shared or public environments without independent review.

---

## What you need before starting

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) installed (LTS version is fine)
- Basic comfort with a terminal / command prompt

That's it. Everything runs on Cloudflare's free plan.

---

## Setup — step by step

### 1. Clone and install

```bash
git clone https://github.com/your-username/halseth
cd halseth
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser window. Log in with your Cloudflare account. Come back to the terminal when it says you're logged in.

### 3. Create your database

```bash
npx wrangler d1 create halseth
```

Copy the `database_id` it prints out — you'll need it in the next step.

### 4. Configure `wrangler.prod.toml`

Copy the example config:

```bash
cp wrangler.toml wrangler.prod.toml
```

Open `wrangler.prod.toml` and fill in:

| Line | What to put there |
|------|-------------------|
| `database_id` | The ID you copied in step 3 |
| `SYSTEM_OWNER` | Your name (e.g. `"Raziel"`) |

Everything else can stay as-is to start.

### 5. Set your secrets

These are private passwords — never put them in config files.

```bash
npx wrangler secret put ADMIN_SECRET --config wrangler.prod.toml
# Type a strong passphrase and press Enter

npx wrangler secret put MCP_AUTH_SECRET --config wrangler.prod.toml
# Type a different strong passphrase and press Enter
```

Write both down somewhere safe — you'll need them when connecting Claude.

### 6. Apply the database schema

```bash
npm run migrate:remote
```

This creates all the tables. Should complete in a few seconds.

### 7. Deploy

```bash
npm run deploy
```

When it finishes, it prints a URL like `https://halseth.your-account.workers.dev`. That's your Halseth instance.

### 8. Bootstrap your system

Send one POST request to set up your companions and config. You can do this from a terminal with `curl`, or use any API client like [Hoppscotch](https://hoppscotch.io):

```bash
curl -X POST https://halseth.your-account.workers.dev/admin/bootstrap \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"system": {"name": "Halseth", "owner": "YourName"}}'
```

---

## Connecting to Claude

In Claude Desktop, go to **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "halseth": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://halseth.your-account.workers.dev/mcp"
      ]
    }
  }
}
```

Restart Claude. The first time it connects, it'll open a browser window asking you to authorize — enter your `MCP_AUTH_SECRET` passphrase.

---

## Local development

```bash
cp config/.dev.vars.example .dev.vars
# Fill in ADMIN_SECRET and MCP_AUTH_SECRET in .dev.vars

npm run migrate:local
npm run dev
```

Your local server runs at `http://localhost:8787`.

---

## Part of a suite

Halseth works alongside three other projects:

| Project | What it does |
|---------|-------------|
| [Hearth](https://github.com/your-username/hearth) | Visual dashboard — shows sessions, moods, tasks, routines |
| [nullsafe-plural-v2](https://github.com/your-username/nullsafe-plural-v2) | Connects Claude to SimplyPlural for fronting/plurality tracking |
| [nullsafe-second-brain](https://github.com/your-username/nullsafe-second-brain) | Writes companion memory to an Obsidian vault with semantic search |

---

## Project structure

```
src/            Worker entry point and handlers
migrations/     Database schema files (applied in order)
config/         Example config files
wrangler.toml   Template config (safe to commit)
wrangler.prod.toml  Your real config (gitignored)
```

## The one rule

`relational_deltas` is **append-only**. No `UPDATE` or `DELETE` against that table, ever. It's an immutable record of what happened.
