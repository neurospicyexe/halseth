# Restoring from a Nullsafe backup

Backups land in `Documents\Nullsafe-Backups\` on the workstation (made by `backup-nullsafe.ps1`, daily via
Task Scheduler; log in `backup.log`). Every file there was **proven restorable when it was made**: the D1
dump was loaded into a fresh SQLite and its counts compared with live; the Second Brain copies passed
`PRAGMA quick_check` and a row count against live, and their checksums matched after download.

| Store | Files | Cadence, kept |
|---|---|---|
| Halseth D1 (the triad's memory) | `d1\halseth-d1-<date>.sql.gz` | daily, 14 + first of each month for 12 months |
| Second Brain vector store | `second-brain\vector-store-<date>.db.zst` | weekly, 4 |
| Second Brain vault write queue | `second-brain\vault-queue-<date>.db.zst` | daily, 14 |

Try the cheaper path first: D1 has Cloudflare **Time Travel** for the last 30 days
(`npx wrangler d1 time-travel restore halseth --timestamp <ISO>`). Use these files for anything older,
a lost account, or a new database.

## Halseth D1

**A raw D1 export does NOT import back into D1.** Rehearsed 10-27: it fails with
`no such table: main.club_rounds`, because the export writes tables in creation order and some child
tables predate their parent. Always reorder first (nothing is edited, only moved; triggers go last so
they do not fire on the restore's own inserts):

```powershell
cd C:\dev\Bigger_Better_Halseth\halseth
# 1. unzip
$gz = "$env:USERPROFILE\Documents\Nullsafe-Backups\d1\halseth-d1-YYYY-MM-DD.sql.gz"
$sql = $gz -replace '\.gz$',''
$i=[IO.File]::OpenRead($gz); $o=[IO.File]::Create($sql); $z=[IO.Compression.GZipStream]::new($i,[IO.Compression.CompressionMode]::Decompress); $z.CopyTo($o); $z.Dispose(); $o.Dispose(); $i.Dispose()
# 2. reorder into an importable file
node scripts/backup/make-d1-restore.mjs $sql restore.sql
# 3. rehearse locally first (throwaway folder, ~4 min for 130 MB)
npx wrangler d1 execute halseth --local --persist-to .\restore-rehearsal --config wrangler.prod.toml --yes --file restore.sql
```

Then, into a **new, empty** D1 database (never on top of the live one):

```powershell
npx wrangler d1 create halseth-restored
npx wrangler d1 execute halseth-restored --remote --yes --file restore.sql
```

Point `wrangler.prod.toml`'s `database_id` at it and deploy. If `--file` answers `AuthenticationError
10000` (a known trap from this machine, STATUS K14 / mig 0143), retry once; failing that, use the
dashboard's D1 import or the REST import API. Rehearsed 10-27 against a local D1: 223,173 statements,
148 tables, row counts identical to live.

To just read old data without restoring: `node --no-warnings scripts/backup/verify-d1-dump.mjs <sql>`
loads it into memory; or open it with any SQLite tool after loading (`sqlite3 old.db < <sql>`, with
foreign keys off, which is the sqlite3 default).

## Second Brain

On the VPS (or the new box), with the service stopped so nothing writes mid-swap:

```bash
sudo systemctl stop second-brain
cd ~/.nullsafe-second-brain
mv vector-store.db vector-store.db.before-restore      # keep the old one until the new one is proven
scp <workstation>:.../vector-store-YYYY-MM-DD.db.zst .  # or copy it over however is easiest
zstd -d vector-store-YYYY-MM-DD.db.zst -o vector-store.db
sqlite3 vector-store.db "PRAGMA quick_check;"          # must print: ok
sudo systemctl start second-brain
```

Same for `vault-queue.db`. Anything Second Brain indexed after the backup date is missing until its
pullers catch up (the Halseth continuity puller re-pulls from its high-water mark).

## Not backed up (yet)

Hermes `state.db` transcripts (`~/.hermes/state.db`, `profiles/{drevan,gaia}/state.db`, ~3 GB total)
are not in this backup. CouchDB (Obsidian LiveSync) is not either; the vault itself is on the
workstation, which the external drives cover.
