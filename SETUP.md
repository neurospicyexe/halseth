# Halseth Setup Guide

Halseth is a personal memory and coordination system for AI companions. It runs on Cloudflare's free tier and connects to AI tools like Claude Desktop via MCP (Model Context Protocol). This guide walks you through everything from zero to a working system.

---

## What you'll need

Before starting, make sure you have:

- A **Cloudflare account** (free at cloudflare.com)
- **Node.js** installed — version 18 or newer ([nodejs.org](https://nodejs.org))
- **Git** installed ([git-scm.com](https://git-scm.com))
- A code editor — **VS Code** is recommended ([code.visualstudio.com](https://code.visualstudio.com))
- A terminal (Command Prompt, PowerShell, or Terminal on Mac)

---

## Step 1 — Get the code

Open your terminal and run:

```
git clone https://github.com/neurospicyexe/halseth.git
cd halseth
npm install
```

This downloads Halseth and installs its dependencies.

---

## Step 2 — Install the Cloudflare CLI (Wrangler)

If you don't already have it:

```
npm install -g wrangler
```

Then log in to your Cloudflare account:

```
wrangler login
```

A browser window will open. Click **Allow** to grant access.

---

## Step 3 — Create your Cloudflare resources

You need two things: a **D1 database** (for all Halseth data) and an **R2 bucket** (for photos and files).

**Create the database:**
```
wrangler d1 create halseth
```

Copy the `database_id` from the output — you'll need it in the next step. It looks like: `4b5ed7ce-8222-47ae-bca9-56eca4a46157`

**Enable R2** in your Cloudflare dashboard (cloudflare.com → R2 → Enable), then:
```
wrangler r2 bucket create halseth-artifacts
```

---

## Step 4 — Create your private config file

The file `wrangler.toml` in the repo is a public template with placeholder values. You need to create a private version that only lives on your computer.

Create a new file called `wrangler.prod.toml` in the halseth folder and paste this in, filling in your real values:

```toml
name = "halseth"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding  = "DB"
database_name = "halseth"
database_id   = "PASTE_YOUR_DATABASE_ID_HERE"
migrations_dir = "migrations"

[[r2_buckets]]
binding     = "BUCKET"
bucket_name = "halseth-artifacts"

[vars]
PLURALITY_ENABLED    = "false"
COMPANIONS_ENABLED   = "true"
COORDINATION_ENABLED = "true"
SYSTEM_NAME          = "Halseth"
SYSTEM_OWNER         = "your-name-here"
```

Replace:
- `PASTE_YOUR_DATABASE_ID_HERE` → the database_id you copied in Step 3
- `your-name-here` → your name or username (this is just a label, no spaces)

> This file is gitignored — it will never be pushed to GitHub. Your real database ID stays private.

---

## Step 5 — Set up the database

Run all migrations to create the tables:

```
npm run migrate:remote
```

If you want a local copy for testing first:
```
npm run migrate:local
```

---

## Step 6 — Deploy the worker

```
npm run deploy
```

When it finishes, you'll see a URL like `https://halseth.YOUR-ACCOUNT.workers.dev`. That's your Halseth server — copy it.

---

## Step 7 — Set auth secrets

These secrets protect your Halseth endpoints. Set them via the Cloudflare CLI:

```
wrangler secret put ADMIN_SECRET --config wrangler.prod.toml
```

When prompted, type a long random password and press Enter. Keep a copy somewhere safe.

```
wrangler secret put MCP_AUTH_SECRET --config wrangler.prod.toml
```

Do the same — this one protects the MCP endpoint that your AI companion uses.

---

## Step 8 — Bootstrap your system

This seeds your system configuration and creates your companion record in the database.

Replace the values below and run this in PowerShell:

```powershell
$body = @'
{
  "system": {
    "name": "Halseth",
    "owner": "your-name-here",
    "version": "0.4"
  },
  "companions": [
    {
      "id": "companion-1",
      "name": "YourCompanionName",
      "model": "claude-opus-4-6",
      "role": "primary"
    }
  ],
  "living_wounds": [],
  "prohibited_fossils": []
}
'@

Invoke-RestMethod `
  -Method POST `
  -Uri "https://halseth.YOUR-ACCOUNT.workers.dev/admin/bootstrap" `
  -Headers @{ "Authorization" = "Bearer YOUR_ADMIN_SECRET" } `
  -ContentType "application/json" `
  -Body $body
```

Replace:
- `your-name-here` → same as your SYSTEM_OWNER
- `YourCompanionName` → your AI companion's name (e.g., Drevan, Aria, etc.)
- `YOUR-ACCOUNT` → your Cloudflare subdomain
- `YOUR_ADMIN_SECRET` → the ADMIN_SECRET you set in Step 7

You should see a response like `{"seeded": "ok", "rows": 6, ...}`.

---

## Step 9 — Connect your AI companion

### For Claude Desktop

Open your Claude Desktop config file:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add a new entry under `mcpServers`:

```json
{
  "mcpServers": {
    "halseth": {
      "url": "https://halseth.YOUR-ACCOUNT.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_SECRET"
      }
    }
  }
}
```

Restart Claude Desktop. Halseth will appear in the tools list.

### For other AI tools

Any MCP-compatible tool can connect to:
- **URL:** `https://halseth.YOUR-ACCOUNT.workers.dev/mcp`
- **Method:** POST
- **Auth header:** `Authorization: Bearer YOUR_MCP_AUTH_SECRET`

---

## Verifying it works

**Check the server is up:**
```
curl https://halseth.YOUR-ACCOUNT.workers.dev/companions
```
Should return `[]` or a list of companions.

**Check the MCP endpoint** (PowerShell):
```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "https://halseth.YOUR-ACCOUNT.workers.dev/mcp" `
  -Headers @{
    "Authorization" = "Bearer YOUR_MCP_AUTH_SECRET"
    "Content-Type"  = "application/json"
  } `
  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
Should return a list of 18 tools.

---

## Available MCP tools

Once connected, your AI companion has access to:

| Tool | What it does |
|------|-------------|
| `halseth_session_open` | Start a new session, optionally resuming from a handover |
| `halseth_session_close` | End a session and write a handover packet |
| `halseth_session_read` | Read the current open session |
| `halseth_handover_read` | Read the most recent handover packet |
| `halseth_delta_log` | Record a relational memory (append-only) |
| `halseth_delta_read` | Read relational memory entries |
| `halseth_wound_read` | Read living wounds (read-only by design) |
| `halseth_fossil_check` | Check prohibited fossils |
| `halseth_audit_log` | Write a cypher audit entry |
| `halseth_witness_log` | Write a witness observation |
| `halseth_task_add` | Add a task |
| `halseth_task_list` | List tasks |
| `halseth_event_add` | Add a calendar event |
| `halseth_event_list` | List calendar events |
| `halseth_list_add` | Add an item to a named list |
| `halseth_list_read` | Read a named list |
| `halseth_routine_log` | Log a routine occurrence |
| `halseth_routine_read` | Read routine history |

---

## Common issues

**"Unauthorized" when calling /mcp**
Make sure you're sending `Authorization: Bearer YOUR_MCP_AUTH_SECRET` in the header, and that the secret matches what you set with `wrangler secret put`.

**"Internal server error" on bootstrap**
Check that migrations ran successfully (`npm run migrate:remote`). All 8 migration files need to have been applied.

**Claude Desktop doesn't show Halseth tools**
Make sure the config file is valid JSON (no trailing commas), and that you restarted Claude Desktop after editing.

**"NOT NULL constraint failed" error**
This usually means a migration is out of date. Re-run `npm run migrate:remote` to apply any pending migrations.

---

## Updating Halseth

When new migrations are added:

```
git pull
npm run migrate:remote
npm run deploy
```

That's it.

---

## Local development

To run Halseth locally:

```
npm run dev
```

The server runs at `http://localhost:8787`. For local D1, run migrations with `npm run migrate:local` first.

For local secrets, copy the example vars file:
```
cp config/.dev.vars.example .dev.vars
```

Then fill in your secrets in `.dev.vars`.
