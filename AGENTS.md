# enchant-api-mcp — Agent Guide

This MCP server exposes the Enchant help desk API to Claude Code and other agents. Read this before using the tools.

**API documentation:** https://dev.enchant.com/api/v1

## Identity

The server resolves the current user at startup from `ENCHANT_USER_EMAIL`. Call `get_me` to see your resolved user ID and name. All message creation tools (`create_note`, `create_reply`) default `user_id` to you — only override if you intentionally need to attribute a message to someone else.

## Read vs write tools

Read-only, no side effects: `get_me`, `list_users`, `list_inboxes`, `list_labels`, `list_tickets`, `get_ticket`, `list_messages`, `list_customers`, `get_customer`, `get_attachment`.

Everything else changes live help desk data: `create_ticket`, `update_ticket`, `add_ticket_labels`, `remove_ticket_labels`, `create_note`, `create_reply`, `create_inbound_reply`, `create_customer`, `update_customer`, `create_contact`, `delete_contact`, `upload_attachment`. Confirm with the user before calling any of them unless they have already asked for that specific change.

## Creating messages

- Internal notes → `create_note` (visible to team only)
- Outbound reply to customer → `create_reply` — **this sends a real email to the customer immediately.** There is no draft state and no undo. Never call it to test, explore, or guess at wording; get the exact body approved by the user first.
- Recording an inbound customer message → `create_inbound_reply` (writes a message into the ticket as if received from the customer; sends nothing, but falsifies the conversation record if used carelessly)
- All message bodies can be plain text (`htmlized: false`) or HTML (`htmlized: true`)

## Pagination

Every list tool returns `{ items, count, page: { has_more, next_page? } }`. Always check `page.has_more` before assuming completeness. Use `per_page` (max 100) and increment `page` to fetch subsequent pages. For large datasets (>10,000), use `since_created_at` instead of high page numbers.

## Ticket embedding

`get_ticket` accepts an `embed` parameter. Use `embed: "messages"` to get a ticket and all its messages in one call. Other embeds: `user`, `inbox`, `customer`, `labels`.

## Finding customers by contact

Use `list_customers` with `contact_type` + `contact_value` to look up a customer before creating a new one. The API supports all three contact types:

- `contact_type: "email", contact_value: "user@example.com"`
- `contact_type: "twitter", contact_value: "@handle"`
- `contact_type: "phone", contact_value: "+15551234567"`

Note: filtering by name is not supported by the API.

## Rate limits

100 credits/minute, burst of 6/second. Each request costs 1 credit. If you hit a 429, wait before retrying — do not retry in a tight loop.
