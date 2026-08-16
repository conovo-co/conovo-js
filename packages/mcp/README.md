# @conovo/mcp

An MCP server that lets a coding agent integrate [Conovo](https://www.conovo.co)
into your platform — and debug the integration afterwards.

Point Claude Code (or any MCP client) at it and say *"integrate Conovo"*: the
agent can read your data model, build and register your payload schema, mint
sandbox sessions, drive test contracts through the real API, wire up webhooks,
and read the request inspector when something 4xxes.

## Setup

```bash
claude mcp add conovo -e CONOVO_SECRET_KEY=sk_test_… -- npx -y @conovo/mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "conovo": {
      "command": "npx",
      "args": ["-y", "@conovo/mcp"],
      "env": { "CONOVO_SECRET_KEY": "sk_test_…" }
    }
  }
}
```

Use an `sk_test_` key while integrating — every session it mints is test mode
end to end: simulated signing, nothing metered, nothing binds.
`CONOVO_API_URL` overrides the API base (defaults to `https://api.conovo.co`).

## Tools

| Tool | What it does |
|---|---|
| `get_overview` | Account status + live contract metrics |
| `get_payload_schema` / `register_payload_schema` | Read / append the payload sample contract fields bind to |
| `infer_payload_schema` | Propose a schema from a sample response, OpenAPI spec, or Prisma schema |
| `get_payload_gaps` | Which fields keep missing from the payload — the schema backlog |
| `create_sandbox_session` | A real `/v1` token against the Sandbox workspace |
| `get_api_reference` | Routes + summaries from the live OpenAPI doc |
| `list_requests` | The request inspector — why a call failed, no bodies ever |
| `get_held_contracts` | Contracts held by validation, with issue codes |
| `list_events` | The content-free audit trail |
| `get_webhook` / `set_webhook` / `test_webhook` | Outbound webhook config + a signed test ping |

## What it deliberately cannot do

No tool touches a live contract, produces a document value, or returns
contract content. The send path stays deterministic and human-gated — the
agent integrates the product; it doesn't operate it.

## License

MIT
