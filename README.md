# linq-chat-sdk

[Linq](https://linqapp.com) adapter for [Chat SDK](https://www.npmjs.com/package/chat) — write your bot logic once, run it on iMessage/SMS via Linq alongside Slack, Telegram, WhatsApp, and friends.

## What's in here

- [`packages/adapter-linq`](packages/adapter-linq) — the adapter package (`@linqapp/chat-sdk-adapter`). Start with its [README](packages/adapter-linq/README.md).
- [`apps/api`](apps/api) — example Nitro app running a single AI bot across Linq, Telegram, and WhatsApp, with webhook routes, setup endpoints, and a small admin UI.

## Development

```bash
pnpm install
pnpm -r test
pnpm -r typecheck
```

The adapter package has no runtime dependencies beyond the official [`@linqapp/sdk`](https://www.npmjs.com/package/@linqapp/sdk), with `chat` as a peer dependency.

## Credits

Originally created by [Fardeem Munir](https://github.com/fardeem). This project began as his work and is maintained by the [Linq](https://linqapp.com) team — thank you, Fardeem 🙏

## License

[Apache-2.0](LICENSE)
