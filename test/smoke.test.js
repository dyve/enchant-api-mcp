// Live smoke test: starts the real server over stdio and calls read-only tools
// against the configured Enchant account. Intended to be run after a dependency
// upgrade, to catch breakage that `node --check` cannot see.
//
// Skips itself when credentials are absent, so it is safe to run anywhere.
// Every tool it calls is read-only — this test never writes to Enchant.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "src/index.js");

const EXPECTED_TOOLS = [
  "add_ticket_labels", "create_contact", "create_customer", "create_inbound_reply",
  "create_note", "create_reply", "create_ticket", "delete_contact", "get_attachment",
  "get_customer", "get_me", "get_ticket", "list_customers", "list_inboxes",
  "list_labels", "list_messages", "list_tickets", "list_users",
  "remove_ticket_labels", "update_customer", "update_ticket", "upload_attachment",
];

// Mirror the server's own resolution order: explicit env vars win, then the dotfile.
function credentials() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(homedir(), ".enchant-api-mcp.env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].trim();
    }
  } catch { /* absent — fall through to the check below */ }
  const complete = env.ENCHANT_TOKEN && env.ENCHANT_SITE && env.ENCHANT_USER_EMAIL;
  return complete ? env : null;
}

const env = credentials();
const skip = env ? false : "no Enchant credentials configured — set them in ~/.enchant-api-mcp.env to run the live smoke test";

let client;

before(async () => {
  if (!env) return;
  client = new Client({ name: "smoke-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env }));
}, { timeout: 30_000 });

after(async () => { await client?.close(); });

// Parses a tool result back into the object the handler passed to ok().
async function callJson(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name} returned an error: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

test("server starts and registers exactly the expected tools", { skip }, async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(t => t.name).sort(), EXPECTED_TOOLS.slice().sort(),
    "registered tool set changed — update EXPECTED_TOOLS, the README permissions block, and AGENTS.md together",
  );
});

test("every tool exposes a description and an input schema", { skip }, async () => {
  const { tools } = await client.listTools();
  for (const t of tools) {
    assert.ok(t.description?.length > 0, `${t.name} has no description`);
    assert.ok(t.inputSchema, `${t.name} has no input schema`);
  }
});

test("get_me resolves the configured user", { skip }, async () => {
  const me = await callJson("get_me");
  assert.equal(me.email, env.ENCHANT_USER_EMAIL);
  assert.ok(me.id, "resolved user has no id — message attribution would break");
});

test("list_tickets returns the documented pagination envelope", { skip }, async () => {
  const res = await callJson("list_tickets", { per_page: 1 });
  assert.ok(Array.isArray(res.items), "items is not an array");
  assert.equal(typeof res.count, "number");
  assert.ok(res.page, "no page object — agents rely on page.has_more");
  assert.ok(Object.hasOwn(res.page, "has_more"));
});

test("zod validation rejects out-of-range input", { skip }, async () => {
  // per_page is capped at 100. This is the cheapest proof that schema validation
  // still works, which is what a zod major upgrade would most likely break.
  const res = await client.callTool({ name: "list_tickets", arguments: { per_page: 5000 } });
  assert.ok(res.isError, "per_page=5000 was accepted — schema validation is not being enforced");
});

test("list_inboxes and list_labels reach the API", { skip }, async () => {
  // Note: unlike the other list tools these return a bare array, not the
  // wrapPaginated envelope. AGENTS.md currently claims every list tool is
  // paginated, which is inaccurate for these two.
  for (const name of ["list_inboxes", "list_labels"]) {
    const res = await callJson(name);
    assert.ok(Array.isArray(res), `${name} did not return an array`);
  }
});
