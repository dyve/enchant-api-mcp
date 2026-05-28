#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

// ── CONFIG ────────────────────────────────────────────────────────────────────
// Reads credentials from ~/.enchant-api-mcp.env (KEY=VALUE format) if env vars are
// not already set. Explicit env vars always take precedence.

const ENV_FILE = join(homedir(), ".enchant-api-mcp.env");
try {
  const text = readFileSync(ENV_FILE, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // File not present — fall through to env var validation below
}

const ENCHANT_TOKEN      = process.env.ENCHANT_TOKEN;
const ENCHANT_SITE       = process.env.ENCHANT_SITE;
const ENCHANT_USER_EMAIL = process.env.ENCHANT_USER_EMAIL;

if (!ENCHANT_TOKEN)      { console.error(`ENCHANT_TOKEN is required (your API token from Enchant Settings → API). Set it in ${ENV_FILE}`); process.exit(1); }
if (!ENCHANT_SITE)       { console.error(`ENCHANT_SITE is required (e.g. 'mycompany' for mycompany.enchant.com). Set it in ${ENV_FILE}`); process.exit(1); }
if (!ENCHANT_USER_EMAIL) { console.error(`ENCHANT_USER_EMAIL is required (your Enchant login email). Set it in ${ENV_FILE}`); process.exit(1); }

const BASE_URL = `https://${ENCHANT_SITE}.enchant.com/api/v1`;

// ── HTTP HELPER ───────────────────────────────────────────────────────────────

async function enchantFetch(method, path, { params, body } = {}) {
  let url = BASE_URL + path;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += "?" + s;
  }
  const init = {
    method,
    headers: {
      "Authorization": `Bearer ${ENCHANT_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const json = JSON.parse(text);
      if (typeof json.error === "string") detail = json.error;
      else if (json.errors) detail = JSON.stringify(json.errors);
    } catch { /* keep raw text */ }
    const err = new Error(`HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    err.retryAfter = res.headers.get("Retry-After") ?? null;
    throw err;
  }
  if (!text) return null;
  return JSON.parse(text);
}

// ── RESPONSE HELPERS ──────────────────────────────────────────────────────────

function ok(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// ── PAGINATION WRAPPER ────────────────────────────────────────────────────────

function wrapPaginated(items, { page = 1, perPage = null } = {}) {
  const count = items.length;
  let has_more;
  if (perPage != null) {
    has_more = count >= perPage;
  } else {
    has_more = null;
  }
  return {
    items,
    count,
    page: {
      has_more,
      ...(has_more === true && { next_page: page + 1 }),
      ...(has_more === null && { note: "No per_page specified; completeness unknown." }),
    },
  };
}

// ── SERVER + addTool ──────────────────────────────────────────────────────────

const server = new McpServer({
  name: "enchant",
  version: "1.0.0",
});

function addTool(name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      const status = e.status ?? null;
      const retryable = status != null && (status === 429 || status >= 500);
      const msg = `Enchant error: ${e.message}`
        + (e.retryAfter ? ` (retry after ${e.retryAfter}s)` : "");
      return { content: [{ type: "text", text: msg }], isError: true,
               _meta: { status, retryable, ...(e.retryAfter && { retry_after: e.retryAfter }) } };
    }
  });
}

// ── STARTUP: RESOLVE CURRENT USER ─────────────────────────────────────────────
// Fetches users once at startup; fails if ENCHANT_USER_EMAIL doesn't match any user.
// ME is available to all tools for defaulting user_id on message creation.

let ME;
{
  let allUsers;
  try {
    allUsers = await enchantFetch("GET", "/users");
  } catch (e) {
    console.error(`Failed to fetch users from Enchant: ${e.message}`);
    process.exit(1);
  }
  ME = (allUsers || []).find(u => u.email === ENCHANT_USER_EMAIL);
  if (!ME) {
    const known = (allUsers || []).map(u => u.email).join(", ");
    console.error(`ENCHANT_USER_EMAIL "${ENCHANT_USER_EMAIL}" not found in Enchant. Known users: ${known}`);
    process.exit(1);
  }
}

// ── TOOLS: IDENTITY ───────────────────────────────────────────────────────────

addTool(
  "get_me",
  "Get the current authenticated user (resolved at startup from ENCHANT_USER_EMAIL).",
  {},
  async () => ok(ME),
);

addTool(
  "list_users",
  "List all team members in this Enchant account.",
  {},
  async () => {
    const users = await enchantFetch("GET", "/users");
    const compact = (users || []).map(({ id, first_name, last_name, email }) => ({ id, first_name, last_name, email }));
    return ok(compact);
  },
);

addTool(
  "list_inboxes",
  "List all inboxes. Use this to find inbox IDs needed for create_ticket or list_tickets filters.",
  {},
  async () => {
    const inboxes = await enchantFetch("GET", "/inboxes");
    return ok(inboxes);
  },
);

addTool(
  "list_labels",
  "List all labels. Use this to find label IDs needed for add_ticket_labels, remove_ticket_labels, or list_tickets filters.",
  {},
  async () => {
    const labels = await enchantFetch("GET", "/labels");
    return ok(labels);
  },
);

// ── TOOLS: TICKETS ────────────────────────────────────────────────────────────

addTool(
  "list_tickets",
  "List tickets with optional filters. Returns paginated results — check page.has_more.",
  {
    state:            z.enum(["open", "hold", "closed"]).optional().describe("Filter by ticket state"),
    user_id:          z.string().optional().describe("Comma-separated user IDs to filter by assignee"),
    inbox_id:         z.string().optional().describe("Comma-separated inbox IDs"),
    label_id:         z.string().optional().describe("Comma-separated label IDs"),
    type:             z.string().optional().describe("Comma-separated ticket types (email, chat, phone, etc.)"),
    spam:             z.boolean().optional().describe("Filter spam tickets"),
    trash:            z.boolean().optional().describe("Filter trashed tickets"),
    since_created_at: z.string().optional().describe("ISO8601 UTC timestamp — tickets created after this time"),
    since_updated_at: z.string().optional().describe("ISO8601 UTC timestamp — tickets updated after this time"),
    sort:             z.enum(["updated_at", "-updated_at", "created_at", "-created_at", "user_id,-updated_at"]).optional(),
    page:             z.number().int().optional().describe("Page number (starts at 1)"),
    per_page:         z.number().int().min(0).max(100).optional().describe("Results per page (0-100)"),
  },
  async ({ state, user_id, inbox_id, label_id, type, spam, trash, since_created_at, since_updated_at, sort, page = 1, per_page }) => {
    const params = { state, user_id, inbox_id, label_id, type, spam, trash, since_created_at, since_updated_at, sort, page, per_page };
    const tickets = await enchantFetch("GET", "/tickets", { params });
    return ok(wrapPaginated(tickets || [], { page, perPage: per_page ?? null }));
  },
);

addTool(
  "get_ticket",
  "Get a single ticket by ID. Use embed to include related resources.",
  {
    ticket_id: z.string().describe("Ticket ID"),
    embed:     z.array(z.enum(["customer", "user", "inbox", "labels", "messages"])).optional().describe("Resources to embed"),
  },
  async ({ ticket_id, embed }) => {
    const params = embed?.length ? { embed: embed.join(",") } : undefined;
    const ticket = await enchantFetch("GET", `/tickets/${ticket_id}`, { params });
    return ok(ticket);
  },
);

addTool(
  "update_ticket",
  "Update a ticket's state, assignee, inbox, labels, subject, spam, or trash status.",
  {
    ticket_id: z.string().describe("Ticket ID"),
    state:     z.enum(["open", "hold", "closed"]).optional(),
    user_id:   z.string().optional().describe("Assign to this user ID (null to unassign)"),
    inbox_id:  z.string().optional().describe("Move to this inbox ID"),
    label_ids: z.array(z.string()).optional().describe("Set labels; empty array removes all labels"),
    subject:   z.string().optional(),
    spam:      z.boolean().optional(),
    trash:     z.boolean().optional(),
  },
  async ({ ticket_id, ...fields }) => {
    const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const ticket = await enchantFetch("PATCH", `/tickets/${ticket_id}`, { body });
    return ok(ticket);
  },
);

addTool(
  "create_ticket",
  "Create a new ticket (no initial message). To add a first message call create_inbound_reply (customer-sent) or create_reply (agent-sent) immediately after.\n\nTwo-step flow:\n  1. create_ticket         → get ticket_id\n  2. create_inbound_reply / create_reply → attach first message",
  {
    type:        z.enum(["email", "chat", "twitter", "phone"]).optional().describe("Ticket type (default: email)"),
    subject:     z.string().describe("Ticket subject"),
    customer_id: z.string().optional().describe("Existing customer ID"),
    customer:    z.object({
      first_name: z.string().optional(),
      last_name:  z.string().optional(),
      contacts:   z.array(z.object({ type: z.string(), value: z.string() })).optional(),
    }).optional().describe("Create or match customer by details (used if customer_id omitted)"),
    user_id:     z.string().optional().describe("Assign to user ID (defaults to current user)"),
    inbox_id:    z.string().describe("Inbox ID — use list_inboxes to find available IDs"),
  },
  async ({ type, subject, customer_id, customer, user_id, inbox_id }) => {
    const body = {
      type: type ?? "email",
      subject,
      user_id: user_id ?? ME.id,
      inbox_id,
      ...(customer_id && { customer_id }),
      ...(customer   && { customer }),
    };
    const ticket = await enchantFetch("POST", "/tickets", { body });
    return ok(ticket);
  },
);

addTool(
  "add_ticket_labels",
  "Add one or more labels to a ticket.",
  {
    ticket_id: z.string().describe("Ticket ID"),
    label_ids: z.array(z.string()).describe("Label IDs to add"),
  },
  async ({ ticket_id, label_ids }) => {
    await enchantFetch("PUT", `/tickets/${ticket_id}/labels/${label_ids.join(",")}`);
    return ok(`Labels added to ticket ${ticket_id}.`);
  },
);

addTool(
  "remove_ticket_labels",
  "Remove one or more labels from a ticket.",
  {
    ticket_id: z.string().describe("Ticket ID"),
    label_ids: z.array(z.string()).describe("Label IDs to remove"),
  },
  async ({ ticket_id, label_ids }) => {
    await enchantFetch("DELETE", `/tickets/${ticket_id}/labels/${label_ids.join(",")}`);
    return ok(`Labels removed from ticket ${ticket_id}.`);
  },
);

// ── TOOLS: MESSAGES ───────────────────────────────────────────────────────────

addTool(
  "list_messages",
  "List all messages (replies and notes) for a ticket.",
  {
    ticket_id: z.string().describe("Ticket ID"),
  },
  async ({ ticket_id }) => {
    const ticket = await enchantFetch("GET", `/tickets/${ticket_id}`, { params: { embed: "messages" } });
    return ok(ticket?.messages ?? []);
  },
);

addTool(
  "create_note",
  "Add an internal note to a ticket. Defaults to the current user.",
  {
    ticket_id:      z.string().describe("Ticket ID"),
    body:           z.string().describe("Note body text"),
    htmlized:       z.boolean().optional().describe("True if body is HTML (default false)"),
    user_id:        z.string().optional().describe("User creating the note (defaults to current user)"),
    attachment_ids: z.array(z.string()).optional().describe("Attachment IDs to include"),
  },
  async ({ ticket_id, body, htmlized = false, user_id, attachment_ids }) => {
    const msgBody = {
      type: "note",
      user_id: user_id ?? ME.id,
      body,
      htmlized,
      ...(attachment_ids && { attachment_ids }),
    };
    const message = await enchantFetch("POST", `/tickets/${ticket_id}/messages`, { body: msgBody });
    return ok(message);
  },
);

addTool(
  "create_reply",
  "Send an outbound reply on a ticket. Defaults to the current user.",
  {
    ticket_id:      z.string().describe("Ticket ID"),
    to:             z.string().describe("Recipient contact (email address or handle)"),
    body:           z.string().describe("Reply body text"),
    htmlized:       z.boolean().optional().describe("True if body is HTML (default false)"),
    user_id:        z.string().optional().describe("Sending user ID (defaults to current user)"),
    attachment_ids: z.array(z.string()).optional().describe("Attachment IDs to include"),
  },
  async ({ ticket_id, to, body, htmlized = false, user_id, attachment_ids }) => {
    const msgBody = {
      type: "reply",
      direction: "out",
      user_id: user_id ?? ME.id,
      to,
      body,
      htmlized,
      ...(attachment_ids && { attachment_ids }),
    };
    const message = await enchantFetch("POST", `/tickets/${ticket_id}/messages`, { body: msgBody });
    return ok(message);
  },
);

addTool(
  "create_inbound_reply",
  "Record an inbound reply on a ticket (e.g. a customer response received outside email). Note: the API may return htmlized: true in the response even when false was sent — this is server-side normalisation, not an error.",
  {
    ticket_id:      z.string().describe("Ticket ID"),
    from_name:      z.string().describe("Sender display name"),
    from:           z.string().describe("Sender contact (email address or handle)"),
    body:           z.string().describe("Reply body text"),
    htmlized:       z.boolean().optional().describe("True if body is HTML (default false)"),
    to:             z.string().optional().describe("Recipient contact"),
    attachment_ids: z.array(z.string()).optional().describe("Attachment IDs to include"),
  },
  async ({ ticket_id, from_name, from, body, htmlized = false, to, attachment_ids }) => {
    const msgBody = {
      type: "reply",
      direction: "in",
      from_name,
      from,
      body,
      htmlized,
      ...(to && { to }),
      ...(attachment_ids && { attachment_ids }),
    };
    const message = await enchantFetch("POST", `/tickets/${ticket_id}/messages`, { body: msgBody });
    return ok(message);
  },
);

// ── TOOLS: CUSTOMERS ──────────────────────────────────────────────────────────

addTool(
  "list_customers",
  "List customers with optional filters. Returns paginated results — check page.has_more. NOTE: the API does not support filtering by name; use contact_type + contact_value to look up by email, Twitter handle, or phone number.",
  {
    contact_type:     z.enum(["email", "twitter", "phone"]).optional().describe("Contact type to filter by"),
    contact_value:    z.string().optional().describe("Contact value — email address, @handle, or phone number"),
    page:             z.number().int().optional().describe("Page number (starts at 1)"),
    per_page:         z.number().int().min(0).max(100).optional().describe("Results per page (0-100)"),
    since_created_at: z.string().optional().describe("ISO8601 UTC timestamp — customers created after this time"),
  },
  async ({ contact_type, contact_value, page = 1, per_page, since_created_at }) => {
    const params = {
      page,
      per_page,
      since_created_at,
      ...(contact_type && contact_value && { "contacts.type": contact_type, "contacts.value": contact_value }),
    };
    const customers = await enchantFetch("GET", "/customers", { params });
    return ok(wrapPaginated(customers || [], { page, perPage: per_page ?? null }));
  },
);

addTool(
  "get_customer",
  "Get a single customer by ID.",
  {
    customer_id: z.string().describe("Customer ID"),
  },
  async ({ customer_id }) => {
    const customer = await enchantFetch("GET", `/customers/${customer_id}`);
    return ok(customer);
  },
);

addTool(
  "create_customer",
  "Create a new customer.",
  {
    first_name: z.string().optional(),
    last_name:  z.string().optional(),
    summary:    z.string().optional(),
    contacts:   z.array(z.object({
      type:  z.enum(["email", "twitter", "phone"]),
      value: z.string(),
    })).optional().describe("Contact methods for this customer"),
  },
  async ({ first_name, last_name, summary, contacts }) => {
    const body = Object.fromEntries(
      Object.entries({ first_name, last_name, summary, contacts }).filter(([, v]) => v !== undefined),
    );
    const customer = await enchantFetch("POST", "/customers", { body });
    return ok(customer);
  },
);

addTool(
  "update_customer",
  "Update a customer's name, summary, or contacts.",
  {
    customer_id: z.string().describe("Customer ID"),
    first_name:  z.string().optional(),
    last_name:   z.string().optional(),
    summary:     z.string().optional(),
    contacts:    z.array(z.object({
      type:  z.enum(["email", "twitter", "phone"]),
      value: z.string(),
    })).optional(),
  },
  async ({ customer_id, ...fields }) => {
    const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const customer = await enchantFetch("PATCH", `/customers/${customer_id}`, { body });
    return ok(customer);
  },
);

addTool(
  "create_contact",
  "Add a contact method (email, twitter, phone) to a customer.",
  {
    customer_id: z.string().describe("Customer ID"),
    type:        z.enum(["email", "twitter", "phone"]).describe("Contact type"),
    value:       z.string().describe("Contact value (e.g. email address)"),
  },
  async ({ customer_id, type, value }) => {
    const contact = await enchantFetch("POST", `/customers/${customer_id}/contacts`, { body: { type, value } });
    return ok(contact);
  },
);

addTool(
  "delete_contact",
  "Remove a contact method from a customer.",
  {
    customer_id: z.string().describe("Customer ID"),
    contact_id:  z.string().describe("Contact ID to remove"),
  },
  async ({ customer_id, contact_id }) => {
    await enchantFetch("DELETE", `/customers/${customer_id}/contacts/${contact_id}`);
    return ok(`Contact ${contact_id} removed from customer ${customer_id}.`);
  },
);

// ── TOOLS: ATTACHMENTS ────────────────────────────────────────────────────────

addTool(
  "get_attachment",
  "Get attachment metadata by ID.",
  {
    attachment_id: z.string().describe("Attachment ID"),
  },
  async ({ attachment_id }) => {
    const attachment = await enchantFetch("GET", `/attachments/${attachment_id}`);
    return ok(attachment);
  },
);

addTool(
  "upload_attachment",
  "Upload a file as a base64-encoded attachment. Returns an attachment ID for use in messages.",
  {
    filename:     z.string().describe("File name including extension"),
    content_type: z.string().describe("MIME type (e.g. image/png, application/pdf)"),
    data:         z.string().describe("Base64-encoded file content"),
  },
  async ({ filename, content_type, data }) => {
    const attachment = await enchantFetch("POST", "/attachments", {
      body: { filename, content_type, data },
    });
    return ok(attachment);
  },
);

// ── START ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
