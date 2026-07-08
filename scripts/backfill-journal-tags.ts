// scripts/backfill-journal-tags.ts
//
// One-time retroactive backfill (2026-07-08): companion_journal rows written before the
// write-time tag classifier shipped have tags=NULL / topic_tags=NULL. This classifies
// them using the SAME classifier the live write path uses (src/synthesis/tag-classifier.ts)
// and generates a batched SQL file of UPDATE statements for `wrangler d1 execute --file`.
//
// Never overwrites an existing tags value (some system writers -- drift, clearing, guardian --
// already set literal static tags like ["drift_floor"]; those are left untouched). Only fills
// columns that are currently NULL.
//
// Usage:
//   npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --json \
//     --command "SELECT id, note_text, tags, topic_tags FROM companion_journal WHERE tags IS NULL OR topic_tags IS NULL" \
//     > /tmp/journal_rows.json
//   npx tsx scripts/backfill-journal-tags.ts /tmp/journal_rows.json /tmp/journal_backfill.sql
//   npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --file=/tmp/journal_backfill.sql

import { readFileSync, writeFileSync } from "node:fs";
import { classifyDomainTags, classifyKeywordTags } from "../src/synthesis/tag-classifier.js";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("Usage: tsx backfill-journal-tags.ts <input.json> <output.sql>");
  process.exit(1);
}

interface Row {
  id: string;
  note_text: string;
  tags: string | null;
  topic_tags: string | null;
}

const raw = JSON.parse(readFileSync(inputPath, "utf-8"));
const rows: Row[] = raw[0]?.results ?? [];

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

const statements: string[] = [];
let tagsBackfilled = 0;
let topicTagsBackfilled = 0;

for (const row of rows) {
  const assignments: string[] = [];
  if (row.tags === null) {
    const tags = JSON.stringify(classifyDomainTags(row.note_text ?? ""));
    assignments.push(`tags = '${sqlEscape(tags)}'`);
    tagsBackfilled++;
  }
  if (row.topic_tags === null) {
    const topicTags = JSON.stringify(classifyKeywordTags(row.note_text ?? ""));
    assignments.push(`topic_tags = '${sqlEscape(topicTags)}'`);
    topicTagsBackfilled++;
  }
  if (assignments.length === 0) continue;
  statements.push(`UPDATE companion_journal SET ${assignments.join(", ")} WHERE id = '${sqlEscape(row.id)}';`);
}

writeFileSync(outputPath, statements.join("\n") + "\n");
console.log(`rows read: ${rows.length}`);
console.log(`tags backfilled: ${tagsBackfilled}`);
console.log(`topic_tags backfilled: ${topicTagsBackfilled}`);
console.log(`statements written: ${statements.length} -> ${outputPath}`);
