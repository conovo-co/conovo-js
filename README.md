# Conovo SDK

Client libraries for [Conovo](https://www.conovo.co) — embedded contract generation
infrastructure for vertical SaaS platforms.

| Package | Description |
| --- | --- |
| [`@conovo/node`](packages/node) | Server SDK: mints session tokens, verifies webhook and connector signatures. Zero dependencies. |
| [`@conovo/react`](packages/react) | Embeddable components: template setup, sending, bulk send, contract inbox, signing. |
| [`@conovo/core`](packages/core) | Shared field taxonomy and value types. |
| [`@conovo/mcp`](packages/mcp) | MCP server exposing the admin and sandbox API to coding agents. |

```sh
npm i @conovo/node @conovo/react
```

Documentation: **https://www.conovo.co/docs** · API reference: **https://api.conovo.co/docs**

## About this repository

This is a **read-only mirror**. These packages are developed in Conovo's main
repository alongside the server they talk to, because several of them are
verified against it by tests that must be able to change both sides in a single
commit — the webhook and connector signature schemes in particular. Publishing
them from here would let the two halves drift between releases.

Issues and discussions are welcome and are read. Pull requests can't be merged
here directly; if you open one, we'll apply the change upstream and credit you,
and it will appear in the next sync.

## Building

```sh
pnpm install
pnpm build
pnpm test
```

## License

MIT — see [LICENSE](LICENSE).
