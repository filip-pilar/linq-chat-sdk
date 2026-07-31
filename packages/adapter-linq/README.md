# @forma/linq-chat-sdk-adapter

Forma-maintained fork of Linq's adapter for [Chat SDK](https://www.npmjs.com/package/chat) (`chat`). Build agentic chatbots that talk over iMessage and SMS through Linq, using the same handler code you'd write for Slack, Telegram, or WhatsApp.

This is not an official Linq package and is not published to npm. Consumers pin
an exact immutable GitHub Release tarball from this repository.

The supported root API intentionally matches the official
`@linqapp/chat-sdk-adapter` package.

## Quick start

```ts
import { createLinqAdapter } from "@forma/linq-chat-sdk-adapter";
import { Chat } from "chat";

const chat = new Chat({
  userName: "mybot",
  adapters: {
    linq: createLinqAdapter({
      apiKey: process.env.LINQ_API_KEY!,
      signingSecret: process.env.LINQ_WEBHOOK_SECRET!,
    }),
  },
});

chat.onDirectMessage(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`you said: ${message.text}`);
});

chat.onReaction(["thumbs_up"], async (event) => {
  await event.thread.post("appreciate the tapback 🫡");
});
```

Then route Linq webhooks to the adapter from any framework with fetch-style handlers:

```ts
// e.g. a Nitro/Next.js/Hono POST route
export default async (request: Request) => {
  return chat.webhooks.linq(request);
};
```

Point a [Linq webhook subscription](https://docs.linqapp.com) at that route and subscribe to at least:

- `message.received`
- `reaction.added`
- `reaction.removed`

Other event types are acknowledged with a `200` and ignored.

## Configuration

| Option          | Required | Description                                                                                                              |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `apiKey`        | yes      | Linq API key used for all outbound API calls.                                                                            |
| `signingSecret` | yes      | Webhook signing secret. Requests are verified with HMAC-SHA256 over `{timestamp}.{raw_body}`, with replay-window checks. |
| `baseURL`       | no       | Override the Linq API base URL (e.g. sandbox).                                                                           |

## Supported features

| Feature                                            | Status                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Inbound text messages                              | ✅                                                                                                                                 |
| Outbound text messages                             | ✅                                                                                                                                 |
| Group chats                                        | ✅ reply to existing groups received via webhook                                                                                   |
| Inbound media (images, audio, files)               | ✅ parsed as attachments with downloadable data                                                                                    |
| Outbound media / file sending                      | ✅ `attachments` and `files` on a message become media parts                                                                       |
| Inbound reactions (tapbacks + custom emoji)        | ✅ dispatch to `onReaction()`                                                                                                      |
| Outbound reactions (add/remove)                    | ✅                                                                                                                                 |
| Edit message                                       | ✅ text, first part only                                                                                                           |
| Fetch message / history / thread                   | ✅                                                                                                                                 |
| Typing indicators                                  | ✅ DMs only (Linq rejects typing in groups)                                                                                        |
| Webhook signature verification + replay protection | ✅                                                                                                                                 |
| Streaming                                          | ⚠️ buffered — recipients see one final message                                                                                     |
| Sticker reactions                                  | ❌ skipped (no Chat SDK equivalent)                                                                                                |
| Delete message                                     | ❌ Linq cannot unsend on the recipient's device                                                                                    |
| `openDM()` / creating chats                        | ❌ Linq creates chats with an initial message, which doesn't match Chat SDK semantics — the adapter only replies to existing chats |
| Modals, cards, slash commands                      | ❌ no Linq equivalent — cards render as fallback text                                                                              |

## Thread IDs

Thread IDs are stable and always take the form `linq:{chatId}`, regardless of whether the thread was first seen via webhook or API. Group vs DM identity is tracked internally from webhook payloads and `chats.retrieve()` calls; legacy `linq:{chatId}:group` / `linq:{chatId}:dm` IDs from older versions still decode.

## Attachments

Attach media by putting `attachments` or `files` on a message:

```ts
await thread.post({
  markdown: "here's the report 📎",
  attachments: [
    { type: "file", url: "https://example.com/report.pdf", mimeType: "application/pdf" },
  ],
});

// or send raw bytes
await thread.post({
  markdown: "fresh render",
  files: [{ filename: "render.png", mimeType: "image/png", data: pngBuffer }],
});
```

How each attachment is delivered:

- **Public HTTPS URL, ≤ 10MB** — sent by reference; Linq downloads it on send. No upload round-trip, so forwarding inbound Linq media (already on `cdn.linqapp.com`) is free.
- **Raw bytes, non-HTTPS URLs, or files > 10MB** — uploaded via `POST /v3/attachments` (up to 100MB) and sent by `attachment_id`.

A message can be media-only (no text). Inbound attachments expose `fetchData()` to download, and survive queue serialization via `rehydrateAttachment` (Linq CDN URLs don't expire). Audio is sent as a downloadable file attachment — the dedicated iMessage voice-memo bubble endpoint isn't wired up yet.

## Reactions

Standard iMessage tapbacks map to normalized Chat SDK emoji in both directions:

| Linq tapback | Chat SDK emoji |
| ------------ | -------------- |
| `like`       | `thumbs_up`    |
| `dislike`    | `thumbs_down`  |
| `love`       | `heart`        |
| `laugh`      | `laugh`        |
| `emphasize`  | `exclamation`  |
| `question`   | `question`     |

Custom emoji reactions pass through the default emoji resolver (e.g. `👍` → `thumbs_up`), falling back to the raw emoji for anything unmapped.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build
```

A full example app (Nitro server wiring Linq, Telegram, and WhatsApp adapters into one bot) lives in [`apps/api`](../../apps/api) in this repo.

## License

[Apache-2.0](../../LICENSE)
