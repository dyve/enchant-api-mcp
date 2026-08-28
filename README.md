# enchant-api-mcp

MCP server for the [Enchant](https://enchant.com) help desk REST API. Enables Claude Desktop, Claude Code, and other MCP-compatible agents to read and manage Enchant tickets, customers, and messages.

**API documentation:** https://dev.enchant.com/api/v1

## Requirements

- Node.js 18+

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get your API token

In Enchant, go to **Settings → API** and install the API app. Copy the generated token.

### 3. Store credentials

Create `~/.enchant-api-mcp.env` (keep this file private — `chmod 600 ~/.enchant-api-mcp.env`):

```bash
ENCHANT_TOKEN=your-token-here
ENCHANT_SITE=yoursite
ENCHANT_USER_EMAIL=you@yourcompany.com
```

The server reads this file at startup. Credentials never need to appear in your MCP config.

### 4. Configure your MCP host

#### Claude Desktop / Cowork

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "enchant": {
      "command": "npx",
      "args": ["enchant-api-mcp"]
    }
  }
}
```

If you have a local clone instead of using `npx`:

```json
{
  "mcpServers": {
    "enchant": {
      "command": "node",
      "args": ["/path/to/enchant-api-mcp/src/index.js"]
    }
  }
}
```

#### Claude Code

```sh
claude mcp add enchant -- npx enchant-api-mcp
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `ENCHANT_TOKEN` | Bearer token from Enchant API settings |
| `ENCHANT_SITE` | Your Enchant subdomain (e.g. `mycompany` for `mycompany.enchant.com`) |
| `ENCHANT_USER_EMAIL` | Your Enchant user email — used to identify "you" for message attribution |

Set these in `~/.enchant-api-mcp.env` or as regular environment variables (env vars take precedence). The server verifies `ENCHANT_USER_EMAIL` against the users list at startup and exits with a clear error if it doesn't match any known user.

These three names are exact and are the only variables the server reads. In particular there is no `ENCHANT_API_KEY` — a value stored under that name is silently ignored, and the server will exit reporting a missing `ENCHANT_TOKEN`.

Do not put the token in a Claude Code `settings.json` `env` block. That file is not created mode `600`, it is often committed to a repository or copied between machines when sharing a setup, and a token in it grants access to your entire Enchant account. Keep it in `~/.enchant-api-mcp.env` with `chmod 600`.

## Claude Code: permissions (optional)

If you use this server with Claude Code, you can pre-declare how each tool is handled in `~/.claude/settings.json`. `allow` runs the tool without asking; `deny` blocks it outright. Anything in neither list falls back to a permission prompt at call time.

The split below allowlists only the read-only tools and denies every tool that changes data. Read-only tools cannot damage anything, so skipping their prompts is safe. The write tools are a different matter — **allowlisting `create_reply` means an agent can send real outbound email to your customers with no confirmation**, and `update_ticket`, `delete_contact` and the rest mutate live help desk data the same way.

```json
{
  "permissions": {
    "allow": [
      "mcp__enchant__get_attachment",
      "mcp__enchant__get_customer",
      "mcp__enchant__get_me",
      "mcp__enchant__get_ticket",
      "mcp__enchant__list_customers",
      "mcp__enchant__list_inboxes",
      "mcp__enchant__list_labels",
      "mcp__enchant__list_messages",
      "mcp__enchant__list_tickets",
      "mcp__enchant__list_users"
    ],
    "deny": [
      "mcp__enchant__add_ticket_labels",
      "mcp__enchant__create_contact",
      "mcp__enchant__create_customer",
      "mcp__enchant__create_inbound_reply",
      "mcp__enchant__create_note",
      "mcp__enchant__create_reply",
      "mcp__enchant__create_ticket",
      "mcp__enchant__delete_contact",
      "mcp__enchant__remove_ticket_labels",
      "mcp__enchant__update_customer",
      "mcp__enchant__update_ticket",
      "mcp__enchant__upload_attachment"
    ]
  }
}
```

If you do want an agent to write to Enchant, drop the relevant tools out of `deny` rather than moving them into `allow` — that leaves you with a prompt per call instead of no prompt at all.

## Authentication note

Enchant API tokens are **account-level** — a single token grants access to all account data. When creating notes or replies, a `user_id` must be specified to attribute the message to a team member. The server resolves your identity at startup and defaults all message creation to your user ID. You can override `user_id` explicitly on any message tool if needed (e.g. to record messages on behalf of another agent).

## Tools

### Identity

| Tool | Description |
|------|-------------|
| `get_me` | Return the current user (resolved at startup) |
| `list_users` | List all team members |

### Tickets

| Tool | Description |
|------|-------------|
| `list_tickets` | List tickets with filters (state, user, inbox, label, type, spam, trash, date) |
| `get_ticket` | Get a single ticket; use `embed` for user/inbox/customer/labels/messages |
| `update_ticket` | Update state, assignee, inbox, labels, subject, spam, or trash |
| `create_ticket` | Create a new email ticket |
| `add_ticket_labels` | Add labels to a ticket |
| `remove_ticket_labels` | Remove labels from a ticket |

### Messages

| Tool | Description |
|------|-------------|
| `list_messages` | List all messages on a ticket |
| `create_note` | Add an internal note (defaults to current user) |
| `create_reply` | Send an outbound reply (defaults to current user) |
| `create_inbound_reply` | Record an inbound reply from a customer |

### Customers

| Tool | Description |
|------|-------------|
| `list_customers` | List customers; filter by contact (email, twitter, phone) |
| `get_customer` | Get a single customer |
| `create_customer` | Create a new customer |
| `update_customer` | Update customer name, summary, or contacts |
| `create_contact` | Add a contact method to a customer |
| `delete_contact` | Remove a contact method from a customer |

### Attachments

| Tool | Description |
|------|-------------|
| `get_attachment` | Get attachment metadata |
| `upload_attachment` | Upload a base64-encoded file; returns an ID for use in messages |

## Pagination

List tools return a `page` object:

```json
{
  "items": [...],
  "count": 25,
  "page": { "has_more": true, "next_page": 2 }
}
```

Always check `page.has_more` before assuming you have the complete list. Pass `page` and `per_page` to paginate.

## Rate limiting

Enchant allows 100 credits/minute (1 credit per request) with a burst of 6 requests/second. The server does not retry automatically — if you receive a rate limit error, wait before retrying.
