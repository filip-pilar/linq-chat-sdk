# @forma/linq-chat-sdk-adapter

Forma-maintained fork of Linq's adapter for [Chat SDK](https://www.npmjs.com/package/chat) (`chat`). Build agentic chatbots that talk over iMessage and SMS through Linq, using the same handler code you'd write for Slack, Telegram, or WhatsApp.

This is not an official Linq package and is not published to npm. Consumers pin
an exact immutable GitHub Release tarball from this repository.

The ordinary Chat SDK API remains compatible with the official
`@linqapp/chat-sdk-adapter` package. This fork also exports a small typed Linq
verified-ingress API for applications that need durable work before Chat SDK
dispatch.

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

## Verified ingress

`chat.webhooks.linq(request)` remains the ordinary one-step path: it verifies
the request and dispatches supported messages and reactions through Chat SDK.

Applications that must complete durable host work before handler execution can
use the same adapter in two phases:

```ts
const verification = await adapter.verifyWebhook(request);

if (!verification.ok) {
  return new Response(verification.error.message, {
    status: verification.error.status,
  });
}

const webhook = verification.webhook;
const webhookOptions = {
  waitUntil: (task: Promise<unknown>) => hostWaitUntil(task),
};

// Persist or correlate provider observations in the application's own model.
await eventStore.record({
  provider: webhook.envelope.provider,
  eventId: webhook.envelope.eventId,
  raw: webhook.rawEvent,
});

if (shouldRunChatHandlers(webhook)) {
  await adapter.dispatchVerifiedWebhook(webhook, webhookOptions);
}

return new Response("OK");
```

`verifyWebhook()` consumes the request body once, verifies its signature once,
parses it once, and does not dispatch. A successful result is bound to the
adapter instance that verified it; `dispatchVerifiedWebhook()` rejects forged
results and results from another adapter. Do not call the one-step handler with
the same consumed `Request` afterward.

`dispatchVerifiedWebhook()` enters the existing Chat SDK dispatch path and
forwards `WebhookOptions`. Awaiting it does not guarantee that every Chat SDK
handler has completed. When `waitUntil` is supplied, Chat SDK registers the
downstream task with it; task lifetime and completion then follow the host's
`waitUntil` behavior. Without `waitUntil`, handler execution still follows the
ordinary `Chat.processMessage()` lifecycle and error handling.

The normalized contract targets Linq webhook version `2026-02-03`. Unsupported
versions return a typed `unsupported_version` failure from `verifyWebhook()` and
are never represented as current-version facts. For compatibility, the
ordinary one-step path continues to acknowledge and structurally dispatch older
signed payloads it previously accepted.

For `message.received`, the result exposes the event/partner/trace envelope,
transport verification scheme, provider message and chat IDs, direct/group
state, receiving and remote endpoints, owner/sender handles, service,
timestamps, parts, attachments, and reply context. `rawEvent` is a detached,
immutable snapshot of the complete authenticated envelope, so public
observation cannot alter later dispatch. Existing Chat SDK `Message.raw`
remains the mutable Linq message data object, preserving current consumer
behavior.

These values are authenticated provider observations, not durable application
identity. Applications remain responsible for identity resolution,
persistence, deduplication, routing, authorization, and execution policy.

## Configuration

| Option          | Required | Description                                                                                                                                                                                                                                                                                            |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apiKey`        | yes      | Linq API key used for all outbound API calls.                                                                                                                                                                                                                                                          |
| `signingSecret` | yes      | Webhook signing secret. Standard Webhooks signatures are verified by the Linq SDK; legacy `X-Webhook-*` signatures remain supported for compatibility. When Linq sends both complete header sets, the adapter verifies the legacy set so existing subscription secrets continue to work as documented. |
| `baseURL`       | no       | Override the Linq API base URL (e.g. sandbox).                                                                                                                                                                                                                                                         |

The adapter also exposes its configured official Linq client without wrapping or
renaming endpoint operations:

```ts
const adapter = createLinqAdapter({
  apiKey: process.env.LINQ_API_KEY!,
  signingSecret: process.env.LINQ_WEBHOOK_SECRET!,
});
const paymentRequests = await adapter.client.paymentRequests.list();
```

`adapter.client` is a read-only property referencing the same `LinqAPIV3`
instance the adapter uses internally. Its native types, validation, and errors follow the
[official Linq API](https://docs.linqapp.com/).

## Feature parity

The adapter's parity target is complete, non-lossy Linq chat and messaging
coverage. Standard Chat SDK APIs remain primary; provider mechanics stay
internal; a small typed Linq extension surface is reserved for native chat
behavior Chat SDK cannot express. Endpoint-shaped account, administration, and
business operations stay on read-only `adapter.client: LinqAPIV3`.

The contact-card roadmap means sharing the sending number's configured Name and
Photo card into an iMessage chat; configuration stays on `adapter.client` or in
the Linq dashboard. Accepting payments over chat is a recipe—not an adapter
feature or batch—composed from `adapter.client.paymentRequests`, general rich-link
delivery, and generic typed `onLinqEvent` passthrough. Agentcard is out of scope.
Experience discovery remains only in the native-client boundary audit.

The full 57-operation audit also records the package boundary. Batch `002`
exposes the official Linq client through read-only `adapter.client` without
duplicating its operations with bespoke wrappers.

Proactive sending is not supported by the adapter today: `openDM()` cannot yet bridge Chat SDK's
thread-before-post contract to Linq's atomic initial-message send without risking split thread
identity. Future Batch `004` owns that standard adapter path after its documented design gates are
satisfied. Native-client sending remains available in the meantime.

See [`FEATURE_PARITY.md`](./FEATURE_PARITY.md) for the authoritative inventory
of every Linq endpoint, message feature, and webhook, including its architectural
disposition, limitations, priority, definition of done, test coverage, recipes,
and independently reviewable upstream PR batch.

## Supported features

| Feature                                            | Status                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Inbound text messages                              | ✅                                                                                                                         |
| Outbound text messages                             | ✅ to existing chats                                                                                                       |
| Group chats                                        | ✅ reply to existing groups received via webhook                                                                           |
| Inbound media (images, audio, files)               | ✅ parsed as attachments with downloadable data                                                                            |
| Outbound media / file sending                      | ✅ to existing chats; `attachments` and `files` become media parts                                                         |
| Inbound reactions (tapbacks + custom emoji)        | ✅ dispatch to `onReaction()`                                                                                              |
| Outbound reactions (add/remove)                    | ✅                                                                                                                         |
| Edit message                                       | ✅ text, first part only                                                                                                   |
| Fetch message / history / thread                   | ✅                                                                                                                         |
| Typing indicators                                  | ✅ DMs only (Linq rejects typing in groups)                                                                                |
| Webhook signature verification + replay protection | ✅                                                                                                                         |
| Two-phase verified webhook ingress                 | ✅ `2026-02-03` typed facts + optional Chat SDK dispatch                                                                   |
| Streaming                                          | ⚠️ buffered — recipients see one final message                                                                             |
| Sticker reactions                                  | ❌ skipped (no Chat SDK equivalent)                                                                                        |
| Delete message                                     | ❌ Linq cannot unsend on the recipient's device                                                                            |
| `openDM()` / proactive sending                     | ❌ unsupported today; assigned to future Batch `004` after its design gates                                                |
| Cards                                              | ⚠️ rendered natively as plain text + image media parts — buttons/selects show their labels but cannot trigger `onAction()` |
| Modals, slash commands                             | ❌ no Linq equivalent                                                                                                      |

## Proactive sending

The adapter currently posts only to canonical existing-chat thread IDs (`linq:{chatId}`). It does
not implement `openDM()` or create a Linq chat behind `thread.post()` yet.

Applications that need proactive sending today can use the configured official client directly.
Use `messages.create()` when Linq should auto-select the sending number:

```ts
import { randomUUID } from "node:crypto";

const result = await adapter.client.messages.create({
  to: ["+15551234567"],
  message: {
    parts: [{ type: "text", value: "Hello from Linq" }],
  },
  idempotencyKey: randomUUID(),
});
```

When the application must choose the sending number explicitly, use
`adapter.client.chats.create()` and follow the official client's initial-message constraints. These
calls retain the official client's native request, response, validation, error, and retry behavior;
they do not create a Chat SDK thread automatically.

Batch `004` is reserved for a future standard Chat SDK proactive path. It must resolve atomic first
sends, canonical thread identity, existing-chat reuse, concurrency, idempotency, sender
selection/failover, first-message restrictions, subsequent thread operations, compatibility, and
sandbox/device coverage before implementation. The adapter will not add bespoke `createChat()` or
`sendMessage()` wrappers. See the
[Batch `004` proactive-send design gate](./FEATURE_PARITY.md#batch-004-proactive-send-design-gate).

## Recipes

Recipes compose the native client with adapter-provided chat primitives; they do
not add workflow-specific adapter methods or appear in implementation batches.

### Accept payments over chat (planned)

Create and manage a Payment Request with
`adapter.client.paymentRequests`, send its `checkout_url` through the general
rich-link message capability, and observe `payment.succeeded`,
`payment.canceled`, or `payment.expired` through generic typed
`adapter.onLinqEvent(...)`. Application code owns reconciliation and payment
state. The native client is available now; rich-link delivery and generic event
passthrough remain planned, so the complete recipe is not supported yet.

Agentcard is not a recipe and remains explicitly out of scope.

## Thread IDs

Thread IDs are stable and always take the form `linq:{chatId}`, regardless of whether the thread was first seen via webhook or API. Group vs DM identity is tracked internally from webhook payloads and `chats.retrieve()` calls; legacy `linq:{chatId}:group` / `linq:{chatId}:dm` IDs from older versions still decode.

## Reliable existing-chat sends

`thread.post()` is the public send API. Each call creates one UUID
`idempotency_key`; the official Linq SDK owns message retries and reuses that
body, so the adapter does not add another retry loop.

The current text/media/card inputs are validated before Linq uploads or message
sends begin:

- a message must contain text or media;
- text is limited to 10,000 characters;
- a message is limited to 100 total parts and 40 public-URL media parts, with card images counted alongside ordinary attachments;
- every URL sent directly to Linq must be valid HTTPS;
- upload filenames must contain 1–255 characters; and
- uploads must contain 1 byte–100MB.

Linq failures use the standard `@chat-adapter/shared` validation, rate-limit,
authentication, permission, not-found, network, and generic adapter errors. The
original Linq error is retained as `cause`; provider code and trace ID remain on
the mapped error for diagnostics, and rate-limit errors retain `retryAfter`.

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

- **Public HTTPS URL, ≤ 10MB** — sent by reference; Linq downloads it on send. No upload round-trip is needed.
- **Raw bytes, non-HTTPS URLs, or files > 10MB** — uploaded via `POST /v3/attachments` (up to 100MB) and sent by `attachment_id`.

Attachment creation uses `maxRetries: 0`. If preparation fails after the
adapter created an attachment but before message sending starts, that attachment
is deleted best-effort without replacing the primary error. Once sending begins,
the adapter does not delete attachments.

A message can be media-only (no text). Inbound attachments persist only their
stable Linq attachment ID in `fetchMetadata`; `fetchData()` and
`rehydrateAttachment()` use that ID to request a fresh download URL. Downloads
require the exact `https://cdn.linqapp.com` origin, reject redirects, enforce a
30-second timeout, verify the declared metadata and response headers, and
stream-count the body. Audio is capped at 25MB; other supported media retains
Linq's 100MB attachment ceiling. Audio is sent as a downloadable file
attachment — the dedicated iMessage voice-memo bubble endpoint isn't wired up
yet.

Batch `012` retains URL-download security/bounding, streaming upload work,
readiness, upload retries, complete format handling, retention, and all
send-time cleanup. The by-reference public-HTTPS behavior above remains
unchanged until then.

## Cards

iMessage/SMS has no rich-card UI, so Chat SDK [cards](https://chat-sdk.dev/docs/cards) are flattened to their closest native equivalent instead of being dropped:

- Title, subtitle, text, fields, links, dividers, and tables render as clean plain text (markdown is stripped — iMessage would show literal `**`).
- `<Image>` elements and the card's `imageUrl` are sent as real image media parts (public HTTPS URLs only; other URLs stay visible in the text).
- Buttons and selects render their labels (e.g. `Options: Approve, Reject`) so the recipient sees what the card offers — but there are no tappable buttons on iMessage, so `onAction()` handlers never fire from this adapter. The adapter logs a warning on every such send so the degradation is visible instead of silent. If you need a working action, include a `LinkButton`/`CardLink` URL or handle plain text replies.
- An explicit `fallbackText` on `{ card, fallbackText }` replaces the generated text; card images are still attached.

```tsx
await thread.post(
  <Card title="Order #1234">
    <Image url="https://example.com/receipt.png" alt="Receipt" />
    <CardText>Your order has been received!</CardText>
    <CardLink url="https://example.com/orders/1234" label="Track order" />
  </Card>,
);
// → one iMessage: text bubble + attached receipt image
```

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

## Live smoke test

`smoke-live.mjs` drives this adapter against the **real Linq API** so you can validate a sandbox in one command. Run `pnpm build` first (it imports `./dist`).

Get a sandbox number with the [Linq CLI](https://www.npmjs.com/package/@linqapp/cli): `linq signup --phone <your cell>`, then grab the token from `~/.linq/config.json`.

```bash
# outbound: bootstrap a chat and send text + two images (one by URL, one pre-uploaded)
LINQ_API_KEY=<token> LINQ_FROM=<sandbox number> LINQ_TEST_TO=<your cell> \
  node smoke-live.mjs send

# cards: send Chat SDK cards end-to-end — a full text card, a card with an image,
# and the image+buttons-only card that used to silently vanish
LINQ_API_KEY=<token> LINQ_FROM=<sandbox number> LINQ_TEST_TO=<your cell> \
  node smoke-live.mjs cards

# inbound: receive real webhooks (text + reactions), optionally echo-reply
LINQ_API_KEY=<token> LINQ_SIGNING_SECRET=<webhook secret> LINQ_ECHO=1 \
  node smoke-live.mjs serve
# then tunnel it (cloudflared/ngrok) and register the URL as a Linq webhook subscription
```

| Env                          | Mode  | Purpose                                                                           |
| ---------------------------- | ----- | --------------------------------------------------------------------------------- |
| `LINQ_API_KEY`               | both  | Linq API token                                                                    |
| `LINQ_FROM` / `LINQ_TEST_TO` | send  | sender (sandbox) number / your phone — or set `LINQ_TEST_CHAT_ID` to reuse a chat |
| `LINQ_SIGNING_SECRET`        | serve | webhook signing secret (from the subscription)                                    |
| `LINQ_BASE_URL`              | both  | override API base URL (optional)                                                  |
| `LINQ_ECHO=1`                | serve | reply to inbound messages so you get a round-trip on the device                   |

## License

[Apache-2.0](../../LICENSE)
