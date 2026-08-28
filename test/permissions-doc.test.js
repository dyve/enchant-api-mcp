// Offline drift check: the README's permissions example must stay in sync with
// the tools the server actually registers. Runs without credentials or network,
// so it is safe in CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Tools that only read. Everything else mutates live help desk data and must
// never appear in an `allow` list.
const READ_TOOLS = [
  "get_attachment", "get_customer", "get_me", "get_ticket", "list_customers",
  "list_inboxes", "list_labels", "list_messages", "list_tickets", "list_users",
];

function registeredTools() {
  const src = readFileSync(join(ROOT, "src/index.js"), "utf8");
  return new Set([...src.matchAll(/addTool\(\s*\n\s*"([a-z_]+)"/g)].map(m => m[1]));
}

function documentedPermissions() {
  const md = readFileSync(join(ROOT, "README.md"), "utf8");
  const block = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map(m => m[1])
    .find(b => b.includes('"permissions"'));
  assert.ok(block, "README has no permissions JSON block");
  const { permissions } = JSON.parse(block);
  const strip = list => (list ?? []).map(n => n.replace(/^mcp__enchant__/, ""));
  return { allow: strip(permissions.allow), deny: strip(permissions.deny) };
}

test("README permissions block is valid JSON and covers every registered tool", () => {
  const registered = registeredTools();
  const { allow, deny } = documentedPermissions();
  const documented = new Set([...allow, ...deny]);

  assert.ok(registered.size > 0, "found no addTool registrations — parser is broken");
  assert.deepEqual(
    [...registered].filter(t => !documented.has(t)).sort(), [],
    "tools registered in src/index.js but missing from the README permissions block",
  );
  assert.deepEqual(
    [...documented].filter(t => !registered.has(t)).sort(), [],
    "tools listed in the README permissions block that the server does not register",
  );
});

test("allow and deny do not overlap", () => {
  const { allow, deny } = documentedPermissions();
  assert.deepEqual(allow.filter(t => deny.includes(t)).sort(), []);
});

test("no write tool is allowlisted", () => {
  const { allow } = documentedPermissions();
  const writeInAllow = allow.filter(t => !READ_TOOLS.includes(t)).sort();
  assert.deepEqual(
    writeInAllow, [],
    "these mutate live data and must not skip the permission prompt — create_reply sends real customer email",
  );
});

test("READ_TOOLS matches the set of tools this repo treats as read-only", () => {
  // Guards the list above against drift: a new read tool should be added here
  // and to the README allow list together.
  const { allow } = documentedPermissions();
  assert.deepEqual(allow.slice().sort(), READ_TOOLS.slice().sort());
});
