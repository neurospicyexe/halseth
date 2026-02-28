# Halseth

A federated companion memory system — Cloudflare Worker backed by D1 (relational store) and R2 (artifact store).

Plurality and companion-mode are **config flags**, not hardcoded assumptions. The schema is **tier-based**: apply only the tiers your deployment needs.

---

## Project layout

```
halseth/
  src/            Worker entry point and request handlers
  migrations/     SQL schema files, one file per tier
  config/         Example configuration files
  docs/           Specification documents
  wrangler.toml   Cloudflare Worker + bindings config
  package.json
  LICENSE
```

---

## Tiers

| Tier | File | Adds |
|------|------|------|
| 0 | `0000_tier0_core.sql` | Identity — companions, sessions |
| 1 | `0001_tier1_memory.sql` | Memory — entries, tags, search metadata |
| 2 | `0002_tier2_relational.sql` | Relational deltas (append-only covenant) |

---

## Config flags

| Variable | Default | Effect |
|----------|---------|--------|
| `PLURALITY_ENABLED` | `false` | Allow multiple companions in one deployment |
| `COMPANIONS_ENABLED` | `true` | Companion-mode vs. pure memory-store mode |

---

## Covenants

- `relational_deltas` is **append-only**. No `UPDATE` or `DELETE` against that table — ever. Violations are bugs, not edge cases.

---

## Quickstart

```bash
npm install
# configure wrangler.toml with your account_id and database_id
npx wrangler d1 migrations apply halseth --local
npx wrangler dev
```

---

## Status

Pre-specification. See `docs/` for the system spec when available.
