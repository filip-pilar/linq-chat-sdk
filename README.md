# linq-chat-sdk

[Linq](https://linqapp.com) adapter for [Chat SDK](https://www.npmjs.com/package/chat) — write your bot logic once, run it on iMessage/SMS via Linq alongside Slack, Telegram, WhatsApp, and friends.

## What's in here

- [`packages/adapter-linq`](packages/adapter-linq) — the adapter package (`@linqapp/chat-sdk-adapter`). Start with its [README](packages/adapter-linq/README.md).
- [`apps/api`](apps/api) — example Nitro app running a single AI bot across Linq, Telegram, and WhatsApp, with webhook routes, setup endpoints, and a small admin UI.

## Development

```bash
pnpm install
pnpm lint
pnpm format      # or format:check
pnpm typecheck
pnpm test
```

The same checks run in CI on every pull request.

The adapter package depends on the official [`@linqapp/sdk`](https://www.npmjs.com/package/@linqapp/sdk) and [`standardwebhooks`](https://www.npmjs.com/package/standardwebhooks) at runtime, with `chat` as a peer dependency.

## Releasing

Bump the adapter version and merge to `main` — publishing to npm is automated from there. See [RELEASING.md](RELEASING.md).

## Credits

Originally created by [Fardeem Munir](https://github.com/fardeem). This project began as his work and is maintained by the [Linq](https://linqapp.com) team — thank you, Fardeem 🙏

## License

[Apache-2.0](LICENSE)
