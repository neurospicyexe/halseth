# Halseth Setup Guide

Halseth is a personal memory and coordination system for AI companions. It runs on
Cloudflare's free tier and connects to AI tools like Claude Desktop and Claude iOS via
MCP (Model Context Protocol). This guide walks you through everything from zero to a
working system — no prior Cloudflare experience needed.

---

## What you'll need

Before starting, make sure you have:

- A **Cloudflare account** (free at cloudflare.com)
- **Node.js 18+** ([nodejs.org](https://nodejs.org))
- **Git** ([git-scm.com](https://git-scm.com))
- A code editor — VS Code is recommended ([code.visualstudio.com](https://code.visualstudio.com))
- A terminal (PowerShell on Windows, Terminal on Mac)

---

## Step 1 — Get the code

```
git clone https://github.com/neurospicyexe/halseth.git
cd halseth
npm install
```

---

## Step 2 — Install and authenticate Wrangler

```
npm install -g wrangler
wrangler login
```

A browser window will open. Click **Allow**.

---

## Step 3 — Create your Cloudflare resources

Run each command once. They create the services Halseth needs.

**D1 database:**
```
wrangler d1 create halseth
```
Copy the `database_id` from the output (looks like `4b5ed7ce-8222-…`). You'll need it in Step 4.

**R2 bucket** (enable R2 in your Cloudflare dashboard first, then):
```
wrangler r2 bucket create halseth-artifacts
```

**Vectorize index** (for semantic memory search):
```
wrangler vectorize create halseth-memories --dimensions=768 --metric=cosine
```

---

## Step 4 — Create your private config file

The `wrangler.toml` in the repo is a public template with placeholder values. You need
a private version that never gets pushed to GitHub.

Create a new file called **`wrangler.prod.toml`** in the halseth folder and paste this,
filling in your real values:

```toml
name = "halseth"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding       = "DB"
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
SYSTEM_NAME          = "Halseth"         # your system's name
SYSTEM_OWNER         = "your-name-here"  # your name, no spaces
BRIDGE_URL           = ""                # leave empty unless using the bridge feature
BRIDGE_SECRET        = ""                # leave empty unless using the bridge feature

[ai]
binding = "AI"

[[vectorize]]
binding    = "VECTORIZE"
index_name = "halseth-memories"
```

Replace:
- `PASTE_YOUR_DATABASE_ID_HERE` → the database_id from Step 3
- `your-name-here` → your name or username

> This file is gitignored — it will never be pushed to GitHub.

---

## Step 5 — Set up the database

```
npm run migrate:remote
```

This runs all 10 migration files and creates every table. If you see all checkmarks, you're good.

Optional — run locally too for development:
```
npm run migrate:local
```

---

## Step 6 — Deploy the worker

```
npm run deploy
```

When it finishes, you'll see your URL:
```
https://halseth.YOUR-ACCOUNT.workers.dev
```
Copy this — you'll use it in Steps 8 and 9.

---

## Step 7 — Set auth secrets

> **Security note:** If you skip this step, your /admin/bootstrap, /notes, /house, and
> /assets endpoints will be open to anyone who knows your URL. Always set these in production.

```
wrangler secret put ADMIN_SECRET --config wrangler.prod.toml
```
Type a strong passphrase when prompted. Keep a copy somewhere safe.

```
wrangler secret put MCP_AUTH_SECRET --config wrangler.prod.toml
```
Same — this protects the AI companion endpoint.

---

## Step 8 — Bootstrap your system

This seeds your system config, companions, and any custom data into the database.
Run it once (it's safe to re-run — uses INSERT OR IGNORE internally).

Replace the values and run in PowerShell:

```powershell
$body = @'
{
  "system": {
    "name": "Halseth",
    "owner": "your-name-here",
    "version": "0.4"
  },
  "companions": [
    { "id": "drevan", "display_name": "Drevan", "role": "companion", "active": 1 },
    { "id": "cypher", "display_name": "Cypher", "role": "audit",     "active": 1 },
    { "id": "gaia",   "display_name": "Gaia",   "role": "seal",      "active": 1 }
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

Replace companion names/roles with your actual system members. You should see
`{"seeded": "ok", ...}` in response.

---

## Step 9 — Connect your AI companion

### Claude Desktop

Open your Claude Desktop config file:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add under `mcpServers`:

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

Restart Claude Desktop. Halseth tools will appear.

### Claude iOS (for Apple Health biometrics)

In the Claude iOS app → Settings → MCP Servers:
- **URL:** `https://halseth.YOUR-ACCOUNT.workers.dev/mcp`
- **Authorization:** `Bearer YOUR_MCP_AUTH_SECRET`

Once connected, Claude on iOS can read your Apple Health data and log it to Halseth using
`halseth_biometric_log`. This is how HRV, sleep, steps, and stress get into the system.

---

## Step 10 — Deploy the Hearth dashboard (optional)

Hearth is a web dashboard that shows your current session, notes, tasks, biometrics,
personality shape, dreams, and relationship metrics. Deploy it free on Vercel.

1. Fork or push the `hearth` folder to its own GitHub repo
2. Import that repo at [vercel.com](https://vercel.com)
3. Set these environment variables in Vercel's project settings:
   - `HALSETH_URL` = `https://halseth.YOUR-ACCOUNT.workers.dev` (no trailing slash)
   - `HALSETH_SECRET` = your `ADMIN_SECRET` value
4. Deploy — Vercel gives you a URL like `https://nullsafe-hearth.vercel.app`

The dashboard auto-refreshes every 30 seconds. No login needed since it's your personal URL.

---

## Step 11 — Autonomous time (optional)

Autonomous time lets Claude spontaneously open a session and explore on a schedule,
without you initiating. This uses Windows Task Scheduler + AutoHotKey.

Requirements:
- [AutoHotKey v2](https://www.autohotkey.com) installed
- Claude Desktop open on your machine

Setup:
1. Open PowerShell **as Administrator**
2. Run:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\setup-autonomous-time.ps1
   ```
3. This creates two scheduled tasks: one at 10am and one at 2pm on weekdays

To customize the trigger message or schedule, edit `scripts\autonomous-time.ahk`
and `scripts\setup-autonomous-time.ps1`.

---

## Step 12 — Bridge (two Halseth instances, optional)

If you and a partner each have a Halseth deployment and want to share tasks, events,
and lists between them:

**What the bridge does:**
- You each decide which categories to share (tasks, events, lists) — toggleable at any time
- Your companion can see partner's shared items with `halseth_bridge_pull`
- Your companion can complete/update partner's items with `halseth_bridge_push_act`
- Partner can never touch your non-shared items

**Setup:**
1. Agree on a shared secret (any passphrase — both deployments need the same value)
2. In **your** `wrangler.prod.toml`:
   ```toml
   BRIDGE_URL    = "https://THEIR-WORKER.workers.dev"
   BRIDGE_SECRET = "your-shared-passphrase"
   ```
3. In **their** `wrangler.prod.toml`:
   ```toml
   BRIDGE_URL    = "https://halseth.YOUR-ACCOUNT.workers.dev"
   BRIDGE_SECRET = "your-shared-passphrase"
   ```
4. Both run `npm run deploy`

**Using the bridge:**
- `halseth_bridge_toggle tasks true` — turn on task sharing (off by default)
- `halseth_task_add "pick up groceries" --shared true` — shared from creation
- `halseth_bridge_mark task <id> true` — share an existing task
- `halseth_bridge_pull` — see partner's shared items
- `halseth_bridge_push_act` — complete their task or list item from your side

To turn off sharing for a category: `halseth_bridge_toggle lists false`

---

## Verifying everything works

**Check the server is up:**
```
curl https://halseth.YOUR-ACCOUNT.workers.dev/presence
```
Should return JSON with system name, house state, session, etc.

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
Should return a list of 28 tools.

---

## All MCP tools (28 total)

| Tool | What it does |
|------|-------------|
| `halseth_session_open` | Start a new session |
| `halseth_session_close` | End a session + write handover packet |
| `halseth_session_read` | Read most recent session by ID or most recent |
| `halseth_handover_read` | Load the last handover for cold-start context |
| `halseth_delta_log` | Log a relational moment — exact language, append-only |
| `halseth_delta_read` | Read recent relational deltas |
| `halseth_memory_search` | Semantic search across all logged moments |
| `halseth_wound_read` | Read living wounds (read-only by covenant) |
| `halseth_fossil_check` | Check prohibited fossil directives |
| `halseth_audit_log` | Log a Cypher audit entry |
| `halseth_witness_log` | Log a Gaia witness observation |
| `halseth_biometric_log` | Log an Apple Health snapshot (HRV, sleep, HR, steps…) |
| `halseth_biometric_read` | Read recent biometric history |
| `halseth_personality_read` | Aggregate relational shape from all logged deltas |
| `halseth_task_add` | Add a task (optional: mark as shared) |
| `halseth_task_list` | List tasks with optional filters |
| `halseth_task_update_status` | Mark a task open / in-progress / done |
| `halseth_event_add` | Add a calendar event (optional: shared) |
| `halseth_event_list` | List upcoming events |
| `halseth_list_add` | Add an item to a named list (optional: shared) |
| `halseth_list_read` | Read items on a named list |
| `halseth_list_item_complete` | Mark a list item done |
| `halseth_routine_log` | Log a routine completion (meds, water, etc.) |
| `halseth_routine_read` | Read today's routine state |
| `halseth_bridge_pull` | Fetch partner's shared items |
| `halseth_bridge_toggle` | Enable or disable sharing for a category |
| `halseth_bridge_mark` | Mark an existing item as shared or private |
| `halseth_bridge_push_act` | Push an action to partner's system |

---

## Troubleshooting

**"Unauthorized" on /mcp**
Your `Authorization: Bearer` header doesn't match `MCP_AUTH_SECRET`. Re-check both values.

**"Internal server error" on bootstrap**
Migrations probably didn't run. Try `npm run migrate:remote` again.

**Claude Desktop doesn't show Halseth tools**
The config JSON must be valid (no trailing commas). Restart Claude Desktop after editing.

**Hearth shows "Could not connect to Halseth"**
Check `HALSETH_URL` in Vercel — no trailing slash. Confirm `HALSETH_SECRET` matches your `ADMIN_SECRET`.

**Bridge pull returns "Bridge not configured"**
Set `BRIDGE_URL` in `wrangler.prod.toml` and redeploy. The URL must be non-empty.

**Autonomous time script "Access is denied"**
Run PowerShell as Administrator when setting up the scheduled tasks.

**"NOT NULL constraint failed" on any insert**
A new migration is probably pending. Run `npm run migrate:remote`.

---

## Updating Halseth

When there are updates or new migrations:

```
git pull
npm run migrate:remote
npm run deploy
```

---

## Local development

```
cp config/.dev.vars.example .dev.vars
# Fill in ADMIN_SECRET and MCP_AUTH_SECRET in .dev.vars

npm run migrate:local
npm run dev
```

Local server runs at `http://localhost:8787`. Local dev uses `wrangler.toml` (not `.prod.toml`).

> Always use `npm run` scripts, not raw `wrangler` commands — the scripts automatically pass
> `--config wrangler.prod.toml` so your real database ID is always used.

---

## Security checklist

- [ ] `ADMIN_SECRET` set via `wrangler secret put` (required — see Step 7)
- [ ] `MCP_AUTH_SECRET` set via `wrangler secret put` (strongly recommended)
- [ ] `wrangler.prod.toml` is in `.gitignore` ✓ (already set up)
- [ ] `.dev.vars` is in `.gitignore` ✓ (already set up)
- [ ] `BRIDGE_SECRET` matches your partner's value exactly (if using bridge)
