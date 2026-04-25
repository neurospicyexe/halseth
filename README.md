# Halseth

A personal memory and coordination server for AI companions. Runs entirely on Cloudflare's free tier — no monthly cost for personal use.

Halseth gives your AI companions persistent memory across sessions: feelings, relational history, tasks, routines, biometrics, and more. Everything stored privately on infrastructure you control.

---

> **Heads up**
> This project was built with AI assistance ("vibe-coded"). Security hardening has been applied — OAuth, input validation, parameterized queries, secret management — but it has not undergone a professional security audit. Use it at your own risk. Not recommended for sensitive data in shared or public environments without independent review.

---

## What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) installed (LTS version is fine)
- Basic comfort with a terminal / command prompt

That's it. Everything runs on Cloudflare's free plan.

---

## Setup

**Not sure where to start?** See **[INSTALL.md](./INSTALL.md)** for a beginner-friendly guide — every step explained, no assumed knowledge.

---

## Quick setup (if you know what you're doing)

```bash
git clone https://github.com/neurospicyexe/halseth
cd halseth
npm install
wrangler login
wrangler d1 create halseth          # copy database_id
wrangler r2 bucket create halseth-artifacts
wrangler vectorize create halseth-memories --dimensions=768 --metric=cosine
cp wrangler.toml wrangler.prod.toml  # fill in database_id + SYSTEM_OWNER
npm run migrate:remote
wrangler secret put ADMIN_SECRET --config wrangler.prod.toml
wrangler secret put MCP_AUTH_SECRET --config wrangler.prod.toml
npm run deploy
```

Then bootstrap via POST `/admin/bootstrap` and connect via MCP at `/mcp`.

---

## Part of a suite

| Project | What it does |
|---------|-------------|
| [Hearth](https://github.com/neurospicyexe/hearth) | Visual dashboard — sessions, moods, tasks, routines |
| [nullsafe-plural-v2](https://github.com/neurospicyexe/nullsafe-plural-v2) | SimplyPlural integration for fronting/plurality tracking |
| [nullsafe-second-brain](https://github.com/neurospicyexe/nullsafe-second-brain) | Companion memory synced to Obsidian with semantic search |

---

## Project structure

```
src/            Worker source code
migrations/     Database schema (applied in order)
config/         Example config files
scripts/        Setup and utility scripts
wrangler.toml   Public template config
wrangler.prod.toml  Your private config (gitignored — never committed)
```

## The one rule

`relational_deltas` is **append-only**. No `UPDATE` or `DELETE` against that table, ever.
