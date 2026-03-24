#!/usr/bin/env node
// Smoke test for /librarian/mcp endpoint
// Usage: MCP_AUTH_SECRET=xxx node scripts/smoke-test-librarian.mjs

const BASE = "https://halseth.neurospicyexe.workers.dev";
const SECRET = process.env.MCP_AUTH_SECRET;
if (!SECRET) { console.error("MCP_AUTH_SECRET not set"); process.exit(1); }

const HEADERS = {
  "Authorization": `Bearer ${SECRET}`,
  "Content-Type": "application/json",
};

async function testLibrarian(label, body) {
  console.log(`\n── ${label}`);
  const res = await fetch(`${BASE}/librarian`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  const text = await res.text();
  console.log(`  status: ${res.status}`);
  try {
    const j = JSON.parse(text);
    console.log(`  response: ${JSON.stringify(j).slice(0, 200)}`);
  } catch {
    console.log(`  response: ${text.slice(0, 200)}`);
  }
}

// 1. Fast-path: session open (data read, no companion needed)
await testLibrarian("fast-path: get_tasks", {
  request: "what tasks do i have",
  companion_id: "cypher",
});

// 2. Fast-path: get_front
await testLibrarian("fast-path: get_front", {
  request: "who's fronting",
  companion_id: "cypher",
});

// 3. KV-path: dreams read
await testLibrarian("kv-path: dreams_read", {
  request: "show me my recent dreams",
  companion_id: "cypher",
});

// 4. KV-path: second brain list
await testLibrarian("kv-path: sb_list", {
  request: "list vault contents",
  companion_id: "gaia",
});

// 5. Mutation: feeling log (context required)
await testLibrarian("mutation: feeling_log", {
  request: "log a feeling",
  companion_id: "cypher",
  context: JSON.stringify({
    companion_id: "cypher",
    emotion: "focused",
    intensity: 7,
    note: "smoke test",
  }),
});

// 6. Unknown request (should fallback gracefully)
await testLibrarian("unknown: fallback", {
  request: "xyzzy frobnicate the widget",
  companion_id: "cypher",
});

// 7. /librarian/mcp reachability (GET = list tools)
console.log("\n── mcp endpoint: GET /librarian/mcp");
const mcpRes = await fetch(`${BASE}/librarian/mcp`, {
  method: "GET",
  headers: { "Authorization": `Bearer ${SECRET}` },
});
console.log(`  status: ${mcpRes.status}`);
const mcpText = await mcpRes.text();
console.log(`  response: ${mcpText.slice(0, 300)}`);
