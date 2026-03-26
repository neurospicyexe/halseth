# Halseth Setup Guide

Halseth is a personal memory and coordination system for AI companions. It runs on
Cloudflare's free tier and connects to AI tools like Claude Desktop and Claude iOS via
MCP (Model Context Protocol). This guide walks you through everything from zero to a
working system — no prior Cloudflare or programming experience needed.

**What is a companion system?** You define a set of AI identities (you can call them
whatever you like — companions, advisors, characters) and Halseth gives them persistent
memory. They remember sessions, feelings, tasks, relational history, and more — across
threads and devices.

**What does free tier mean?** Everything in this guide costs nothing. Cloudflare's free
plan covers everything Halseth needs for personal use.

---

## What you'll need

Before starting, make sure you have:

- A **Cloudflare account** (free at cloudflare.com)
- **Node.js 18+** — the engine that runs the install scripts ([nodejs.org](https://nodejs.org))
- **Git** — downloads the code ([git-scm.com](https://git-scm.com))
- A code editor — VS Code is recommended ([code.visualstudio.com](https://code.visualstudio.com))
- A terminal — PowerShell on Windows (search "PowerShell" in Start), Terminal on Mac

> **New to terminals?** A terminal is a text-based way to give your computer instructions.
> You type a command and press Enter. Each step below tells you exactly what to type.

---

## Step 1 — Get the code

Open your terminal, navigate to a folder where you want to keep this project, and run:

```
git clone https://github.com/neurospicyexe/halseth.git
cd halseth
npm install
```

`npm install` downloads all the dependencies. It may take a minute. When it finishes
you'll see your prompt again.

---

## Step 2 — Install and authenticate Wrangler

Wrangler is Cloudflare's command-line tool. It's how you deploy and manage your worker.

```
npm install -g wrangler
wrangler login
```

A browser window will open. Click **Allow**. When your terminal says "Successfully logged in",
you're ready for the next step.

---

## Step 3 — Create your Cloudflare resources

Run each command once. They create the services Halseth needs on your Cloudflare account.

**D1 database** (where all your data lives):
```
wrangler d1 create halseth
```
Copy the `database_id` from the output — it looks like `4b5ed7ce-8222-4c58-...`.
You'll paste it in Step 4.

**R2 bucket** (for file attachments — enable R2 in your Cloudflare dashboard first):
```
wrangler r2 bucket create halseth-artifacts
```

**Vectorize index** (for memory search):
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
SYSTEM_NAME          = "Halseth"         # your system's name -- can be anything
SYSTEM_OWNER         = "your-name-here"  # your name or username, no spaces
BRIDGE_URL           = ""                # leave empty unless using the bridge feature
BRIDGE_SECRET        = ""                # leave empty unless using the bridge feature

[ai]
binding = "AI"

[[vectorize]]
binding    = "VECTORIZE"
index_name = "halseth-memories"
```

Replace:
- `PASTE_YOUR_DATABASE_ID_HERE` with the database_id from Step 3
- `your-name-here` with your name or a username (no spaces)

> This file is gitignored — it will never be pushed to GitHub.

---

## Step 5 — Set up the database

```
npm run migrate:remote
```

This runs all the migration files in order and creates every table. If you see a list of
checkmarks or "Applied" messages, you're good. If you see errors, re-check that your
`database_id` in `wrangler.prod.toml` is correct.

Optional — also set up a local copy for testing:
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

> **Why this matters:** These are passwords that protect your data. Without them, anyone
> who knows your worker URL could read or write to your system.

```
wrangler secret put ADMIN_SECRET --config wrangler.prod.toml
```
Type a strong passphrase when prompted. Keep a copy in a password manager.

```
wrangler secret put MCP_AUTH_SECRET --config wrangler.prod.toml
```
Same — this protects the AI companion endpoint specifically.

---

## Step 8 — Bootstrap your system

This seeds your system config and companion identities into the database.
Run it once (it's safe to re-run — uses INSERT OR IGNORE internally).

**You define your own companions here.** Replace the example names, IDs, and roles
with whatever fits your system. You can have 1, 2, 3, or more.

Replace the placeholder values and run in PowerShell:

```powershell
$body = @'
{
  "system": {
    "name": "Halseth",
    "owner": "your-name-here",
    "version": "0.4"
  },
  "companions": [
    { "id": "companion-one",   "display_name": "First Companion",   "role": "companion", "active": 1 },
    { "id": "companion-two",   "display_name": "Second Companion",  "role": "companion", "active": 1 },
    { "id": "companion-three", "display_name": "Third Companion",   "role": "companion", "active": 1 }
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

**What to fill in:**
- `your-name-here` — your name or username
- `companion-one` / `companion-two` / `companion-three` — short IDs, lowercase, no spaces (e.g. `sage`, `ember`, `anchor`)
- `First Companion` etc. — the display names your companions use
- `role` — a label for each companion's function (e.g. `"companion"`, `"guide"`, `"witness"`) — used for display only
- `YOUR-ACCOUNT` — your Cloudflare subdomain from Step 6
- `YOUR_ADMIN_SECRET` — the passphrase you set in Step 7

You should see `{"seeded": "ok", ...}` in response.

---

## Step 9 — Connect your AI companion

**What is MCP?** MCP (Model Context Protocol) is how AI tools like Claude connect to
external data. When you add Halseth as an MCP server, Claude gains access to all the
tools listed at the bottom of this guide — memory, tasks, feelings, and more.

### Claude Desktop

Open your Claude Desktop config file in a text editor:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
  (paste that path into File Explorer's address bar)
- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add under `mcpServers` (create the `mcpServers` key if it doesn't exist):

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

Restart Claude Desktop. Halseth tools will appear in Claude's tool list.

### Claude iOS (for Apple Health biometrics)

In the Claude iOS app: Settings → MCP Servers → Add:
- **URL:** `https://halseth.YOUR-ACCOUNT.workers.dev/mcp`
- **Authorization:** `Bearer YOUR_MCP_AUTH_SECRET`

Once connected, Claude on iOS can read your Apple Health data and log it to Halseth using
`halseth_biometric_log`. This is how HRV, sleep, steps, and stress get into the system.

---

## Step 10 — Deploy the Hearth dashboard (optional)

Hearth is a web dashboard that shows your current session, notes, tasks, biometrics,
and relationship metrics at a glance. Deploy it free on Vercel.

1. Fork or push the `hearth` folder to its own GitHub repo
2. Import that repo at [vercel.com](https://vercel.com)
3. Set these environment variables in Vercel's project settings:
   - `HALSETH_URL` = `https://halseth.YOUR-ACCOUNT.workers.dev` (no trailing slash)
   - `HALSETH_SECRET` = your `ADMIN_SECRET` value
4. Deploy — Vercel gives you a URL like `https://your-hearth.vercel.app`

The dashboard auto-refreshes every 30 seconds. No login needed since it's your personal URL.

---

## Step 11 — Autonomous time (optional)

Autonomous time lets your AI companion spontaneously open a session and explore on a
schedule, without you initiating. This uses Windows Task Scheduler + AutoHotKey.

Requirements:
- [AutoHotKey v2](https://www.autohotkey.com) installed
- Claude Desktop open on your machine

Setup:
1. Open PowerShell **as Administrator** (right-click PowerShell → Run as Administrator)
2. Run:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\setup-autonomous-time.ps1
   ```
3. This creates two scheduled tasks: one at 10am and one at 2pm on weekdays

To customize the trigger message or schedule, edit `scripts\autonomous-time.ahk`
and `scripts\setup-autonomous-time.ps1`.

---

## Step 12 — Bridge (two Halseth instances, optional)

If you and someone else each have a Halseth deployment and want to share tasks, events,
and lists between them:

**What the bridge does:**
- Each side decides which categories to share (tasks, events, lists) — toggleable any time
- Your companion can see their shared items with `halseth_bridge_pull`
- Your companion can act on their items with `halseth_bridge_push_act`
- Neither side can touch the other's non-shared items

**Setup:**
1. Agree on a shared secret passphrase (both deployments need the same value)
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
- `halseth_bridge_pull` — see their shared items
- `halseth_bridge_push_act` — act on their task or list item from your side

To turn off sharing for a category: `halseth_bridge_toggle lists false`

---

## Verifying everything works

**Check the server is up** (PowerShell):
```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "https://halseth.YOUR-ACCOUNT.workers.dev/presence" `
  -Headers @{ "Authorization" = "Bearer YOUR_ADMIN_SECRET" }
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
Should return a list of all available tools.

---

## Available MCP tools

| Tool | What it does |
|------|-------------|
| `halseth_session_open` | Start a new session |
| `halseth_session_orient` | Boot call — creates session, returns identity + state |
| `halseth_session_ground` | Second boot call — returns tasks, notes, threads, synthesis |
| `halseth_session_close` | End a session and write a handover packet |
| `halseth_session_read` | Read a session by ID or the most recent one |
| `halseth_handover_read` | Load the last handover packet for cold-start context |
| `halseth_delta_log` | Log a relational moment — exact language, append-only |
| `halseth_delta_read` | Read recent relational deltas |
| `halseth_memory_search` | Semantic search across all logged moments |
| `halseth_wound_read` | Read living wounds |
| `halseth_wound_add` | Add a new living wound |
| `halseth_fossil_check` | Check prohibited fossil directives |
| `halseth_audit_log` | Log an audit entry |
| `halseth_witness_log` | Log a witness observation |
| `halseth_feeling_log` | Log a feeling or emotional state |
| `halseth_feelings_read` | Read recent feelings history |
| `halseth_dream_log` | Log a dream |
| `halseth_dreams_read` | Read logged dreams |
| `halseth_dream_seed_read` | Read dream seeds for a companion |
| `halseth_journal_add` | Add a human journal entry |
| `halseth_journal_read` | Read human journal entries |
| `halseth_companion_note_add` | Add a note between companions |
| `halseth_companion_notes_read` | Read companion notes |
| `halseth_biometric_log` | Log a health snapshot (HRV, sleep, HR, steps, stress) |
| `halseth_biometric_read` | Read recent biometric history |
| `halseth_eq_snapshot` | Take an emotional quotient snapshot |
| `halseth_eq_read` | Read EQ history |
| `halseth_state_update` | Update a companion's SOMA state floats and mood |
| `halseth_personality_read` | Aggregate relational shape from all logged deltas |
| `halseth_house_read` | Read current house state |
| `halseth_set_autonomous_turn` | Advance the autonomous time rotation |
| `halseth_task_add` | Add a task |
| `halseth_task_list` | List tasks |
| `halseth_task_update_status` | Mark a task open / in-progress / done |
| `halseth_event_add` | Add a calendar event |
| `halseth_event_list` | List upcoming events |
| `halseth_list_add` | Add an item to a named list |
| `halseth_list_read` | Read items on a named list |
| `halseth_list_item_complete` | Mark a list item done |
| `halseth_routine_log` | Log a routine completion |
| `halseth_routine_read` | Read today's routine state |
| `halseth_bridge_pull` | Fetch a partner's shared items |
| `halseth_bridge_toggle` | Enable or disable sharing for a category |
| `halseth_bridge_mark` | Mark an existing item as shared or private |
| `halseth_bridge_push_act` | Push an action to a partner's system |

---

## Troubleshooting

**"Unauthorized" on /mcp**
Your `Authorization: Bearer` header doesn't match `MCP_AUTH_SECRET`. Re-check both values match exactly.

**"Internal server error" on bootstrap**
Migrations probably didn't run or didn't complete. Try `npm run migrate:remote` again.

**Claude Desktop doesn't show Halseth tools**
The config JSON must be valid (no trailing commas, matching brackets). Use a JSON validator
if unsure. Restart Claude Desktop after editing.

**Hearth shows "Could not connect to Halseth"**
Check `HALSETH_URL` in Vercel — no trailing slash. Confirm `HALSETH_SECRET` matches your `ADMIN_SECRET`.

**Bridge pull returns "Bridge not configured"**
Set `BRIDGE_URL` in `wrangler.prod.toml` and redeploy. The URL must be non-empty.

**Autonomous time script "Access is denied"**
Run PowerShell as Administrator when setting up the scheduled tasks.

**"NOT NULL constraint failed" on any insert**
A new migration is pending. Run `npm run migrate:remote`.

**Wrangler says "7403" when running migrations**
Your Cloudflare API token is missing the D1:Edit permission. Go to Cloudflare dashboard →
My Profile → API Tokens → edit your token and add D1 Database: Edit.

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
- [ ] `wrangler.prod.toml` is in `.gitignore` (already configured)
- [ ] `.dev.vars` is in `.gitignore` (already configured)
- [ ] `BRIDGE_SECRET` matches your partner's value exactly (if using bridge)
