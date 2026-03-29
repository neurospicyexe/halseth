# Halseth Setup Guide

Halseth is a personal memory system for AI companions. It gives your companions persistent memory across sessions — feelings, tasks, relational history, and more — stored privately on infrastructure you control.

**The short version of what you're about to do:**
1. Download the code and install its dependencies
2. Create three free services on Cloudflare (a database, a file store, and a search index)
3. Write a private config file that connects everything together
4. Deploy your Halseth server to the internet
5. Tell your AI companion how to find it

This takes about 20–30 minutes. You don't need to understand everything — just follow each step and the system will tell you if something is wrong.

---

## Before you start

You need four things installed on your computer:

| What | Why you need it | Get it |
|------|----------------|--------|
| **Cloudflare account** (free) | Where your server and database will live | [cloudflare.com](https://cloudflare.com) → Sign Up |
| **Node.js** (LTS version) | Runs the install and deploy scripts | [nodejs.org](https://nodejs.org) → Download LTS |
| **Git** | Downloads the code from GitHub | [git-scm.com](https://git-scm.com) → Downloads |
| **A terminal** | How you run the commands in this guide | PowerShell on Windows (search it in Start); Terminal on Mac |

> **Never used a terminal?** It's a window where you type short commands and press Enter. The commands below tell you exactly what to type. You don't need to understand what they do — just copy and run them.

---

## Step 1 — Download the code

Open your terminal, navigate to wherever you keep projects (your Desktop is fine), and run these three commands one at a time:

```
git clone https://github.com/neurospicyexe/halseth.git
cd halseth
npm install
```

`npm install` downloads everything Halseth needs to run. It might take a minute. When your prompt reappears, it's done.

✅ **Success looks like:** No red error lines. Some yellow warnings are normal.

---

## Step 2 — Log in to Cloudflare

Wrangler is Cloudflare's tool for managing your server. Run:

```
npm install -g wrangler
wrangler login
```

A browser tab will open. Click **Allow**. Come back to your terminal when it says "Successfully logged in".

✅ **Success looks like:** Terminal says `Successfully logged in` or similar.

---

## Step 3 — Create your Cloudflare resources

You need to create three things on your Cloudflare account. Run each command separately and wait for it to finish before running the next one.

### The database (where all your data lives)

Think of this like a spreadsheet file that lives in the cloud.

```
wrangler d1 create halseth
```

After it runs, you'll see something like:
```
✅ Successfully created DB 'halseth'

[[d1_databases]]
database_id = "4b5ed7ce-8222-4c58-a8b4-a7d1e3b5f2a9"
```

**Copy that `database_id` value — you'll need it in Step 4.**
It looks like a string of letters and numbers separated by dashes.

### The file store (for attachments and assets)

Think of this like a private folder in the cloud.

First, go to your Cloudflare dashboard at [dash.cloudflare.com](https://dash.cloudflare.com) → R2 → Enable R2 (free, just needs a confirmation click). Then run:

```
wrangler r2 bucket create halseth-artifacts
```

✅ **Success looks like:** Terminal says "Created bucket 'halseth-artifacts'".

### The search index (for memory search)

This lets your companion search through memories semantically — by meaning, not just keywords.

```
wrangler vectorize create halseth-memories --dimensions=768 --metric=cosine
```

✅ **Success looks like:** Terminal says the index was created.

---

## Step 4 — Create your private config file

The repo includes a public template (`wrangler.toml`) that has placeholder values. You need to create your own private version that has your real values in it.

**This file will never be uploaded to GitHub — it's on your computer only.**

Create a new file called `wrangler.prod.toml` in the `halseth` folder. You can do this by copying the template:

```
cp wrangler.toml wrangler.prod.toml
```

Then open `wrangler.prod.toml` in any text editor (Notepad, VS Code, etc.) and find these lines to update:

| What to find | What to change it to |
|-------------|---------------------|
| `database_id = "..."` | Paste the database_id you copied in Step 3 |
| `SYSTEM_OWNER = "..."` | Your name or username (no spaces, e.g. `"yourname"`) |

Everything else can stay as-is.

> The full config, for reference — your file should look like this when you're done:
>
> ```toml
> name = "halseth"
> main = "src/index.ts"
> compatibility_date = "2025-01-01"
> compatibility_flags = ["nodejs_compat"]
>
> [[d1_databases]]
> binding       = "DB"
> database_name = "halseth"
> database_id   = "PASTE-YOUR-DATABASE-ID-HERE"
> migrations_dir = "migrations"
>
> [[r2_buckets]]
> binding     = "BUCKET"
> bucket_name = "halseth-artifacts"
>
> [vars]
> PLURALITY_ENABLED    = "false"
> COMPANIONS_ENABLED   = "true"
> COORDINATION_ENABLED = "true"
> SYSTEM_NAME          = "Halseth"
> SYSTEM_OWNER         = "your-name-here"
> BRIDGE_URL           = ""
> BRIDGE_SECRET        = ""
>
> [ai]
> binding = "AI"
>
> [[vectorize]]
> binding    = "VECTORIZE"
> index_name = "halseth-memories"
> ```

---

## Step 5 — Set up the database tables

This creates all the storage structures your system needs. Run:

```
npm run migrate:remote
```

You'll see a list of items being applied. This usually finishes in under 10 seconds.

✅ **Success looks like:** A list of migrations with checkmarks or "Applied" next to each one.

> **If you see errors here:** Double-check that the `database_id` in your `wrangler.prod.toml` is exactly right — no extra spaces, complete value.

---

## Step 6 — Deploy your server

This uploads your Halseth server to Cloudflare and makes it live. Run:

```
npm run deploy
```

When it finishes, you'll see your server's URL:

```
https://halseth.YOUR-ACCOUNT-NAME.workers.dev
```

**Copy this URL — you'll use it in the next few steps.**

✅ **Success looks like:** A URL printed at the end with no error messages.

---

## Step 7 — Set your passwords

These are the passwords that protect your data. Anyone who knows your server URL would need one of these to access anything.

Run each command and type a strong passphrase when it asks. Keep both passphrases somewhere safe (a password manager is ideal).

```
wrangler secret put ADMIN_SECRET --config wrangler.prod.toml
```
Type a passphrase and press Enter. You won't see it as you type — that's normal.

```
wrangler secret put MCP_AUTH_SECRET --config wrangler.prod.toml
```
Use a **different** passphrase here. Press Enter.

✅ **Success looks like:** Terminal says "✅ Success! Uploaded secret" for each one.

---

## Step 8 — Set up your companions

This step tells Halseth who your companions are. You'll send one request that seeds their identities into the database.

**Replace these values before running:**
- `your-name-here` → your name or username
- `companion-one`, `companion-two`, `companion-three` → short IDs for each companion, lowercase, no spaces (for example: `sage`, `echo`, `anchor`)
- `First Companion` etc. → the display names you want to use
- `YOUR-ACCOUNT-NAME` → the part of your worker URL before `.workers.dev`
- `YOUR_ADMIN_SECRET` → the passphrase you set in Step 7

Run in PowerShell:

```powershell
$body = @'
{
  "system": {
    "name": "Halseth",
    "owner": "your-name-here",
    "version": "0.4"
  },
  "companions": [
    { "id": "companion-one",   "display_name": "First Companion",  "role": "companion", "active": 1 },
    { "id": "companion-two",   "display_name": "Second Companion", "role": "companion", "active": 1 },
    { "id": "companion-three", "display_name": "Third Companion",  "role": "companion", "active": 1 }
  ],
  "living_wounds": [],
  "prohibited_fossils": []
}
'@

Invoke-RestMethod `
  -Method POST `
  -Uri "https://halseth.YOUR-ACCOUNT-NAME.workers.dev/admin/bootstrap" `
  -Headers @{ "Authorization" = "Bearer YOUR_ADMIN_SECRET" } `
  -ContentType "application/json" `
  -Body $body
```

✅ **Success looks like:** A response containing `"seeded": "ok"`.

> You can have 1, 2, 3, or more companions — just add or remove entries from the `companions` list. The `id` values are internal identifiers. The `display_name` is what gets shown in logs and dashboards.

---

## Step 9 — Connect your AI companion

MCP (Model Context Protocol) is how AI tools like Claude talk to external systems. Adding Halseth as an MCP server gives your companion access to all of Halseth's memory and coordination tools.

### Claude Desktop

Find your Claude Desktop config file:
- **Windows:** Open File Explorer and paste this in the address bar: `%APPDATA%\Claude\`
  Open the file called `claude_desktop_config.json`
- **Mac:** Open Finder → Go → Go to Folder → paste: `~/Library/Application Support/Claude/`
  Open `claude_desktop_config.json`

If the file doesn't exist yet, create it with this content. If it already exists, add the `halseth` block inside `mcpServers` (create `mcpServers` if it isn't there):

```json
{
  "mcpServers": {
    "halseth": {
      "url": "https://halseth.YOUR-ACCOUNT-NAME.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_SECRET"
      }
    }
  }
}
```

Replace `YOUR-ACCOUNT-NAME` and `YOUR_MCP_AUTH_SECRET` with your actual values. Save the file.

Restart Claude Desktop completely (quit and reopen, not just close the window).

✅ **Success looks like:** When you start a conversation in Claude Desktop, the Halseth tools appear in Claude's available tools list. You can ask Claude "what halseth tools do you have?" to verify.

### Claude iOS (for Apple Health data)

In the Claude iOS app: Settings → MCP Servers → Add Server:
- **URL:** `https://halseth.YOUR-ACCOUNT-NAME.workers.dev/mcp`
- **Authorization header:** `Bearer YOUR_MCP_AUTH_SECRET`

Once connected, Claude on iOS can read your Apple Health data and log things like HRV, sleep, and steps directly to Halseth.

---

## Step 10 — Hearth dashboard (optional)

Hearth is a visual web dashboard showing your current session, mood, tasks, biometrics, and relationship data. It deploys free on Vercel.

1. Push the `hearth` folder to its own GitHub repository
2. Go to [vercel.com](https://vercel.com) and import that repository
3. In Vercel's project settings, add these environment variables:
   - `HALSETH_URL` → `https://halseth.YOUR-ACCOUNT-NAME.workers.dev` (no trailing slash)
   - `HALSETH_SECRET` → your `ADMIN_SECRET` value
4. Click Deploy — you'll get a URL like `https://your-hearth.vercel.app`

The dashboard refreshes automatically every 30 seconds.

---

## Step 11 — Autonomous time (optional, Windows only)

Autonomous time lets a companion open a session and explore on a schedule without you starting it. Uses Windows Task Scheduler and AutoHotKey to trigger Claude Desktop automatically.

What you need first:
- [AutoHotKey v2](https://www.autohotkey.com) installed
- Claude Desktop open and running on your machine

Setup:
1. Copy the example config: in the `scripts` folder, copy `autonomous-time-config.example.ps1` to a new file called `autonomous-time-config.ps1` (this one stays private — it's gitignored)
2. Open your new `autonomous-time-config.ps1` and fill in your companion project names to match what they're called in Claude Desktop
3. Open PowerShell **as Administrator** (right-click PowerShell in the Start menu → Run as Administrator)
4. Run:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\setup-autonomous-time.ps1
   ```

This creates two scheduled tasks — one at 12:30 PM and one at 1:30 AM. Each time they fire, the script checks that you're idle (not actively using your computer) before doing anything.

---

## Step 12 — Bridge: connecting two Halseth instances (optional)

If you and someone else each have a Halseth deployment and want to share tasks, events, or lists between them, the bridge feature handles that.

**How it works:** Each side independently decides what to share. Neither side can see or touch the other's non-shared items.

Setup:
1. Agree on a shared secret passphrase with the other person
2. In **your** `wrangler.prod.toml`, add:
   ```toml
   BRIDGE_URL    = "https://THEIR-WORKER.workers.dev"
   BRIDGE_SECRET = "the-shared-passphrase"
   ```
3. In **their** `wrangler.prod.toml`, add:
   ```toml
   BRIDGE_URL    = "https://halseth.YOUR-ACCOUNT-NAME.workers.dev"
   BRIDGE_SECRET = "the-shared-passphrase"
   ```
4. Both of you run `npm run deploy`

To use the bridge, your companion can call these tools:
- `halseth_bridge_toggle tasks true` — turn on task sharing (off by default)
- `halseth_bridge_pull` — see their shared items
- `halseth_bridge_push_act` — act on their task from your side
- `halseth_bridge_mark task <id> true` — share a specific existing item

---

## Verifying everything works

**Check your server is up** (run in PowerShell, replacing the placeholders):

```powershell
Invoke-RestMethod `
  -Method GET `
  -Uri "https://halseth.YOUR-ACCOUNT-NAME.workers.dev/presence" `
  -Headers @{ "Authorization" = "Bearer YOUR_ADMIN_SECRET" }
```

✅ Should return a block of JSON with your system name and state info.

**Check the MCP endpoint:**

```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "https://halseth.YOUR-ACCOUNT-NAME.workers.dev/mcp" `
  -Headers @{
    "Authorization" = "Bearer YOUR_MCP_AUTH_SECRET"
    "Content-Type"  = "application/json"
  } `
  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

✅ Should return a list of all available tools.

---

## Updating Halseth

When there are new updates or migrations:

```
git pull
npm run migrate:remote
npm run deploy
```

That's it — pull the latest code, apply any new database changes, redeploy.

---

## Available tools

These are all the tools your companion will have access to through MCP:

| Tool | What it does |
|------|-------------|
| `halseth_session_open` | Start a new session |
| `halseth_session_orient` | Boot call — loads identity, state, and continuity in one go |
| `halseth_session_ground` | Second boot call — loads tasks, notes, open threads, synthesis |
| `halseth_session_close` | End a session and write a handover for next time |
| `halseth_session_read` | Read a session by ID or the most recent one |
| `halseth_handover_read` | Load the last handover packet (cold-start context) |
| `halseth_delta_log` | Log a relational moment — exact words, append-only |
| `halseth_delta_read` | Read recent relational deltas |
| `halseth_memory_search` | Semantic search across all logged moments |
| `halseth_wound_read` | Read living wounds |
| `halseth_wound_add` | Add a living wound |
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
| `halseth_state_update` | Update a companion's state floats and mood |
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
| `halseth_bridge_pull` | Fetch your partner's shared items |
| `halseth_bridge_toggle` | Enable or disable sharing for a category |
| `halseth_bridge_mark` | Mark an existing item as shared or private |
| `halseth_bridge_push_act` | Push an action to a partner's system |

---

## Troubleshooting

**"Unauthorized" when connecting**
Your `Authorization: Bearer` header doesn't match the secret you set. Double-check you're copying the passphrase exactly — no extra spaces.

**"Internal server error" on bootstrap**
Migrations probably didn't complete. Run `npm run migrate:remote` again and look for errors.

**Claude Desktop doesn't show Halseth tools**
The config JSON must be valid (no trailing commas, all brackets matched). Copy it into a JSON validator if unsure. Quit Claude Desktop fully and reopen after editing the config.

**Hearth shows "Could not connect to Halseth"**
Check that `HALSETH_URL` in Vercel has no trailing slash. Confirm `HALSETH_SECRET` matches your `ADMIN_SECRET` exactly.

**Bridge shows "Bridge not configured"**
Set `BRIDGE_URL` in `wrangler.prod.toml` and run `npm run deploy` again.

**Autonomous time script says "Access is denied"**
You need to run PowerShell as Administrator (right-click → Run as Administrator) when running the setup script.

**"NOT NULL constraint failed" on any action**
A new migration is pending. Run `npm run migrate:remote`.

**Wrangler says error "7403" when running migrations**
Your Cloudflare API token is missing a permission. Go to Cloudflare dashboard → My Profile → API Tokens → edit your token → add "D1 Database: Edit".

---

## Local development

If you want to run Halseth on your own computer for testing before deploying:

```
cp config/.dev.vars.example .dev.vars
```

Open `.dev.vars` and fill in `ADMIN_SECRET` and `MCP_AUTH_SECRET` (these can be simple test values for local use).

```
npm run migrate:local
npm run dev
```

Your local server runs at `http://localhost:8787`. Use this URL for local testing instead of your workers.dev URL.

---

## Security checklist

Before sharing your server URL with anyone:

- [ ] `ADMIN_SECRET` set via `wrangler secret put` (Step 7)
- [ ] `MCP_AUTH_SECRET` set via `wrangler secret put` (Step 7)
- [ ] `wrangler.prod.toml` is gitignored — confirm it never appears in any `git status` output
- [ ] `.dev.vars` is gitignored — same check
- [ ] `BRIDGE_SECRET` matches your partner's value exactly (if using the bridge)
