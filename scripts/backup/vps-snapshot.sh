#!/usr/bin/env bash
# vps-snapshot.sh <daily|weekly>  (2026-10-27) -- run ON the VPS by backup-nullsafe.ps1 (piped over ssh).
#
# Snapshots Second Brain's SQLite stores into /tmp/nsb-backup, proves each copy, compresses, prints
# checksums. daily = vault-queue.db (pending vault writes, tiny); weekly adds vector-store.db (3.6 GB,
# everything Second Brain has indexed).
#
# Why `.backup` and not VACUUM INTO: the store holds a sqlite-vec virtual table (vec0) the sqlite3 CLI
# cannot load, and VACUUM re-runs CREATE VIRTUAL TABLE; `.backup` copies pages and needs no module.
# Measured 10-27: 37s for 3.6 GB with Second Brain live, zero busy/locked errors in its log (it runs
# better-sqlite3's 5s busy timeout; `.backup` takes the lock 100 pages at a time). The copy is proven
# with PRAGMA quick_check plus an `embeddings` row count against live (copy may trail live by the
# rows written during the copy, never exceed it). zstd -3: 3.6 GB -> ~0.9 GB in ~10s.
#
# Output contract (parsed by backup-nullsafe.ps1): `SHA <sha256> <file>` per file, `ROWS <copy> <live>`
# on weekly runs, `OK` last. Any failure prints `ERR <why>` and exits non-zero; nothing half-made stays.
set -euo pipefail
MODE="${1:-daily}"
SRC="$HOME/.nullsafe-second-brain"
OUT=/tmp/nsb-backup
mkdir -p "$OUT"
rm -f "$OUT"/*.db "$OUT"/*.zst
trap 'rm -f "$OUT"/*.db' EXIT

snap() {  # snap <name>: online page copy + quick_check
  sqlite3 "$SRC/$1" ".timeout 30000" ".backup $OUT/$1"
  local qc; qc=$(sqlite3 "$OUT/$1" "PRAGMA quick_check;")
  [ "$qc" = "ok" ] || { echo "ERR quick_check $1: $qc"; exit 4; }
}

snap vault-queue.db
files="vault-queue.db"

if [ "$MODE" = "weekly" ]; then
  size=$(stat -c %s "$SRC/vector-store.db")
  avail=$(df --output=avail -B1 "$OUT" | tail -1)
  [ "$avail" -gt $((size * 2)) ] || { echo "ERR /tmp has $avail bytes free, need 2x $size"; exit 3; }
  snap vector-store.db
  copy=$(sqlite3 "$OUT/vector-store.db" "SELECT COUNT(*) FROM embeddings;")
  live=$(sqlite3 "$SRC/vector-store.db" "SELECT COUNT(*) FROM embeddings;")
  if [ "$copy" -gt "$live" ] || [ $((live - copy)) -gt 500 ]; then echo "ERR rows copy=$copy live=$live"; exit 5; fi
  echo "ROWS $copy $live"
  files="$files vector-store.db"
fi

cd "$OUT"
for f in $files; do zstd -q -3 -T0 --rm "$f"; done
for f in $files; do echo "SHA $(sha256sum "$f.zst" | cut -d' ' -f1) $f.zst"; done
echo OK
