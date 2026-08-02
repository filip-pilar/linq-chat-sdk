# linq-chat-sdk

[Linq](https://linqapp.com) adapter for [Chat SDK](https://www.npmjs.com/package/chat) — write your bot logic once, run it on iMessage/SMS via Linq alongside Slack, Telegram, WhatsApp, and friends.

## What's in here

- [`packages/adapter-linq`](packages/adapter-linq) — the Forma-maintained adapter package (`@forma/linq-chat-sdk-adapter`). Start with its [README](packages/adapter-linq/README.md).
- [`apps/api`](apps/api) — example Nitro app running a single AI bot across Linq, Telegram, and WhatsApp, with webhook routes, setup endpoints, and a small admin UI.

## Development

```bash
pnpm install
pnpm -r test
pnpm -r typecheck
```

The adapter package uses the official [`@linqapp/sdk`](https://www.npmjs.com/package/@linqapp/sdk)
and Chat SDK's shared adapter utilities, with `chat` as a peer dependency.

## Fork maintenance

- `main` is the canonical Forma development branch.
- `upstream/main` is a read-only source for Linq updates; merge reviewed updates into `main` without rewriting published history.
- Release tags and assets are immutable. Never move or rebuild an existing release.
- Use temporary branches only for isolated or concurrent work, then delete them after they are integrated and verified.

## Credits

Originally created by [Fardeem Munir](https://github.com/fardeem) and developed by the [Linq](https://linqapp.com) team. This fork is maintained by Forma — thank you, Fardeem and Linq.

## License

[Apache-2.0](LICENSE)
