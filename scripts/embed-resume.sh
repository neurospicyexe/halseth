#!/usr/bin/env bash
# Resume embedding a Halseth table into Vectorize, page by page, until done or the daily
# Workers AI quota runs out.
#
# WHY THIS EXISTS
# ---------------
# Workers AI free tier allows 10,000 neurons/day. Embedding backlogs are therefore quota-bound,
# not time-bound: `POST /admin/rebuild-embeddings` will page happily until it hits
#
#     AiError 4006: you have used up your daily free allocation of 10,000 neurons
#
# The endpoint is idempotent (deterministic vector ids, upsert), so re-running is free and safe.
# Run this once a day after 00:00 UTC until it reports DONE.
#
# On 2026-07-09 a 4,022-row companion_journal rebuild consumed the day's allocation, leaving
# 4,441 wm_continuity_notes unembedded -- the notes whose missing index IS the orphan_memory
# finding the whole boot audit circled.
#
# USAGE (on the VPS, where HALSETH_URL + HALSETH_SECRET live):
#   set -a; . /app/nullsafe-discord/.env; set +a
#   bash scripts/embed-resume.sh wm_continuity_notes
#   bash scripts/embed-resume.sh companion_journal
#
# Exit 0 = table fully embedded. Exit 2 = quota exhausted, run again tomorrow.

set -uo pipefail

TABLE="${1:?usage: embed-resume.sh <table> [page_size]}"
PAGE="${2:-500}"
: "${HALSETH_URL:?missing HALSETH_URL}"
: "${HALSETH_SECRET:?missing HALSETH_SECRET}"

offset=0
total=0

while :; do
  resp="$(curl -s -X POST \
    "${HALSETH_URL}/admin/rebuild-embeddings?table=${TABLE}&limit=${PAGE}&offset=${offset}" \
    -H "Authorization: Bearer ${HALSETH_SECRET}")"

  n="$(printf '%s' "$resp"    | grep -oP "\"${TABLE}\":\K[0-9]+" || echo 0)"
  more="$(printf '%s' "$resp" | grep -oP '"has_more":\K(true|false)' || echo false)"

  # The endpoint surfaces batch errors rather than swallowing them (that visibility is the only
  # reason the quota ceiling was ever found). Quota exhaustion is not a failure -- it is a pause.
  if printf '%s' "$resp" | grep -q '"errors"'; then
    if printf '%s' "$resp" | grep -qiE '4006|neuron'; then
      echo "[embed-resume] ${TABLE}: quota exhausted at offset=${offset} (embedded ${total} this run)."
      echo "[embed-resume] Re-run after 00:00 UTC. Re-running is idempotent."
      exit 2
    fi
    echo "[embed-resume] ${TABLE}: batch error at offset=${offset}:"
    printf '%s\n' "$resp"
    exit 1
  fi

  total=$(( total + n ))
  echo "[embed-resume] ${TABLE}: offset=${offset} embedded=${n} total=${total}"

  [ "$more" = "true" ] || break
  offset=$(( offset + PAGE ))
done

echo "[embed-resume] DONE ${TABLE}: ${total} embedded."
