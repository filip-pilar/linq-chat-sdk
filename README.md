# linq-chat-sdk

A [Linq](https://linqapp.com) adapter for [Chat SDK](https://www.npmjs.com/package/chat). It lets
Chat SDK applications receive and send iMessage, RCS, and SMS messages through an existing Linq
chat while retaining access to Linq-specific capabilities where the standard interface has no
faithful equivalent.

## Repository

- [`packages/adapter-linq`](packages/adapter-linq) contains the Forma-maintained adapter.
- [`apps/api`](apps/api) is an example Nitro application using Linq alongside other adapters.

## Development

```bash
pnpm install
pnpm check
```

`pnpm check` runs the canonical webhook event-name drift check, lint, formatting, tests,
TypeScript contracts, and workspace builds. CI runs the same check on Node.js 20 and 24.

The adapter currently uses `@linqapp/sdk@0.44.3` for provider operations, Chat SDK `4.38.1`, and
`standardwebhooks` for inbound authentication. Its verified webhook envelope remains adapter-owned
because the installed Linq SDK does not provide the required verification/event contract.

## Maintenance

`main` is Forma's development branch. `upstream/main` is a read-only source for reviewed Linq
updates. Do not rewrite published history or rebuild existing release tags.

Originally created by [Fardeem Munir](https://github.com/fardeem) and developed by the
[Linq](https://linqapp.com) team. Licensed under [Apache-2.0](LICENSE).
