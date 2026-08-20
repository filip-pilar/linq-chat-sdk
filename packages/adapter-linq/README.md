# @forma/linq-chat-sdk-adapter

Forma-maintained fork of Linq's adapter for [Chat SDK](https://www.npmjs.com/package/chat) (`chat`). Build agentic chatbots that talk over iMessage and SMS through Linq, using the same handler code you'd write for Slack, Telegram, or WhatsApp.

This is not an official Linq package and is not published to npm. Consumers pin
an exact immutable GitHub Release tarball from this repository.

The current Chat SDK dependency baseline requires Node.js 20 or newer.

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

### Linq message options transport

`linqMessage(content, options)` attaches immutable Linq-specific send metadata to an ordinary Chat
SDK postable. Strings become `{ raw }` messages; Markdown/AST, cards, files, and attachments keep
their standard shapes. The result works with `thread.post()` and `thread.reply()` and keeps their
normal returned identity, history, and serialization behavior. Text options also travel through
`SentMessage.edit()`; standalone rich links cannot because Linq's current edit API is text-only.

```ts
import { linqMessage } from "@forma/linq-chat-sdk-adapter";

await thread.post(
  linqMessage(
    { markdown: "**Deployment complete**" },
    { decorations: [{ range: [0, 10], style: "underline" }] },
  ),
);
```

The options are a send-time adapter input; they are not added to the returned `SentMessage` or
provider-backed history. The adapter renders raw text, Markdown/AST, and static card text to the
final plain-text part, then maps standard bold, italic, and strikethrough nodes to Linq decorations.
Manual `decorations` add underline, the same standard styles, or a supported animation. Their
`[start, end)` ranges target the final trimmed text and use UTF-16 code units, so most emoji occupy
two positions and combining marks are not normalized.

Exact duplicate decorations collapse. Style ranges may overlap, including derived/manual and
nested styles. Animation ranges may be adjacent but cannot overlap any style or animation. Ranges
must contain two integer endpoints, satisfy `0 <= start < end <= text.length`, and name exactly one
supported style or animation. Invalid decorations fail before attachment preparation or a Linq API
call. These rules are `Contract-verified`; recipient rendering has not been device-verified and is
not an adapter completion gate.

Posting and replies send the compiled text and decorations through the ordinary Chat SDK path.
Edits use the same deterministic plain-text rendering, but Linq SDK `0.42.0` exposes a text-only
message-part update contract and therefore cannot replace decorations.

`preferredService` maps to the message-level `preferred_service` request field. Omission leaves the
field out so Linq uses its documented iMessage → RCS → SMS selection. Explicit `"iMessage"` is
iMessage-only with no fallback. Explicit `"RCS"` and `"SMS"` are passed through exactly; Linq
currently documents both as RCS-when-supported with SMS fallback and no iMessage attempt. Screen
and bubble `effect` values map beside `parts` at message level. Omitted service keeps effects and
decorations best-effort. Explicit RCS/SMS with an effect or any manual decoration rejects locally
before media preparation, logging, or a provider call; standard derived formatting remains allowed
and may degrade to plain text on a protocol that does not render decorations. These are request
contracts, not recipient-presentation or delivery claims.

`richLink` sends one canonical native `link` part. Pass empty ordinary content because the link
must stand alone:

```ts
await thread.post(linqMessage("", { richLink: "https://example.com/preview" }));
```

The adapter requires a valid HTTPS URL of at most 2,048 characters and rejects coexistence with
text, cards, files, or attachments before UUID generation, logging, media preparation, or provider
I/O. Omitted service preserves Linq's iMessage → RCS → SMS selection; explicit service follows the
same `preferredService` contract above. Linq documents rich previews on iMessage and RCS and a bare
URL fallback on SMS. Those are provider request/fallback contracts, not a device-presentation claim.
Standard cards, files, attachments, returned identity, history, and serialization remain unchanged.

### Linq conversation facade

Ordinary replies and reactions stay on Chat SDK's `Thread` and `SentMessage` APIs. Use the narrow
conversation facade only when Linq's zero-based message-part index matters:

```ts
const conversation = adapter.conversation(thread);

await conversation.replyToPart(messageId, 1, "Reply to the second part");
await conversation.addReaction(messageId, "heart", { partIndex: 0 });
await conversation.removeReaction(messageId, "heart", { partIndex: 0 });
await conversation.stopTyping();
await conversation.shareContactCard();
const fromUrl = await conversation.sendVoiceMemo({
  url: "https://media.example.com/memo.m4a",
});
const fromAttachment = await conversation.sendVoiceMemo({
  attachmentId: "33333333-3333-3333-3333-333333333333",
});
await conversation.group.update({
  displayName: "Team Discussion",
  iconUrl: "https://media.example.com/group.png",
});
await conversation.group.addParticipant("+15550000001");
await conversation.group.removeParticipant("former@example.com");
await conversation.group.leave();
```

The facade accepts a Thread owned by this adapter instance or a canonical existing-chat ID in the
form `linq:{chat UUID}`. Message IDs must be UUIDs, and indexes must be non-negative integers.
Reaction options preserve omission separately from explicit `0`. `replyToPart()` still travels
through Chat SDK reply processing and returns a canonical `SentMessage`; no provisional identity,
database mutation, or delivery/presentation guarantee is added.

The same frozen facade now declares the complete cohesive Linq conversation surface. Common
operations are `stopTyping()`, `shareContactCard()`, and `sendVoiceMemo()`; existing-group
operations are under `.group`; location request/retrieval is under `.location`. `stopTyping()` and
`shareContactCard()` are implemented through the official client with shared adapter errors. Voice
memos accept exactly one public HTTPS URL or existing Linq attachment UUID and return only the
accepted message ID, canonical thread ID, and voice-memo attachment ID. Existing-group methods map
to the official update, participant, and leave operations. Location methods map to the official
request and retrieval operations.

Stopping typing works for direct and group chats and acknowledges only that Linq accepted the
request. Contact-card sharing takes no body, requires a configured active card and prior outbound
activity, and is useful only for iMessage; the adapter does not add capability probes, cadence
scheduling, or a recipient-save guarantee. Repeated calls remain repeated provider requests—Linq
documents that calls within 24 hours do not present the option more than once.

Voice-memo URL, source-exclusivity, and UUID validation run before provider I/O. Linq documents a
10 MB limit for direct URL sources and up to 100 MB for pre-uploaded attachments; remote size,
format, reachability, attachment ownership, and content remain provider validations. Acceptance is
not delivery, playback, retention, or recipient-presentation proof. Existing typed message
lifecycle events can observe later provider outcomes without adapter polling or correlation
workflows. Raw bytes, `FileUpload`, upload readiness, retries, and cleanup remain outside this API.

Group updates accept only `displayName` and a public HTTPS `iconUrl`; empty updates reject locally.
Participant handles must be an E.164 phone number or email address. Linq currently supports
participant management only for iMessage groups, requires at least three remaining members, and
requires at least four active members including the sending line before leaving. The adapter
rejects a direct chat only when its existing canonical facts identify it as direct; an opaque owned
canonical ID goes to Linq without a classification probe. Every successful method resolves `void`
for request acceptance only, and repeated calls remain repeated provider operations. Later
`chat.group_*` or `participant.*` webhook observations are separate asynchronous facts; the adapter
does not claim request-to-event correlation without an explicit provider correlation key.

Location retrieval is typed as a canonical thread plus immutable participant locations with
longitude-first coordinates, optional valid altitude, address, locality, and the original valid
provider timestamp string. Malformed rows are skipped independently without reordering usable
siblings; no usable rows produce an immutable empty result. `request()` resolves only when Linq
accepts the prompt request: it does not establish recipient consent, coordinates, sharing duration,
or delivery. Requests are documented for one-to-one iMessage chats; known groups reject locally,
while service compatibility for an opaque canonical chat remains provider-enforced without a
capability probe. Retrieval is an independent on-demand snapshot for direct or group chats. Hosts
that need fresh coordinates should poll conservatively while they need the data and stop according
to their own lifecycle; the adapter owns no timer, interval, retry, cache, or identity resolution.

Current `location.sharing.started` and `location.sharing.stopped` webhooks expose typed participant
and consent-window facts through `onLinqEvent()`. They do not contain coordinates or correlate a
request to a later event; coordinate refresh remains retrieval-based. The authenticated
`rawEvent` stays available losslessly, and future webhook versions remain unsupported but retained.

Mark-read remains `Thread.markAsRead()`, and account or administrative operations remain on
`adapter.client`.

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

Other verified event types can be observed with typed one/many/all `adapter.onLinqEvent()`
registration. Standard message/reaction dispatch still runs where applicable. The adapter
atomically deduplicates both paths by partner and provider event ID before callbacks.

```ts
const unsubscribe = adapter.onLinqEvent(["message.delivered", "message.failed"], async (event) => {
  if (event.type === "message.delivered") {
    console.log(event.data.providerMessageId, event.data.deliveredAt);
  } else {
    console.log(event.data.code, event.data.reason, event.envelope.traceId);
  }
});

unsubscribe();
```

Generic callbacks do not delay the one-step webhook response. Pass the host's `waitUntil` through
the webhook options so their completion remains alive after acknowledgement. Without it, a
serverless host may terminate before callbacks finish. A claimed callback is at-most-once
attempted: failure is logged and isolated, and a duplicate delivery will not invoke it again.

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
await eventStore.recordIfAbsent({
  provider: webhook.envelope.provider,
  partnerId: webhook.envelope.partnerId,
  eventId: webhook.envelope.eventId,
  raw: webhook.rawEvent,
  rawBodyBase64: webhook.rawBodyBase64,
  transport: webhook.transport,
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

`dispatchVerifiedWebhook()` enters the existing Chat SDK dispatch path and forwards
`WebhookOptions`. Awaiting it does not mean Chat SDK or generic event handlers have completed. When
`waitUntil` is supplied, both paths register their downstream tasks with it; task lifetime and
completion then follow the host's `waitUntil` behavior. Without `waitUntil`, callback completion is
not guaranteed on serverless hosts.

Commit the authenticated observation before dispatch and return a non-success response if that
commit fails, so a provider retry can try persistence again before the adapter claims the event.
Use a uniqueness key containing provider, authenticated partner ID, and provider event ID. If
downstream side effects require retries beyond one callback attempt, transactionally enqueue them
with the observation and run them from an application-owned worker; `waitUntil` extends request
lifetime but is not a durable queue.

The normalized contract targets Linq webhook version `2026-02-03`. Authenticated older, future, and
unknown non-empty versions are preserved losslessly as `kind: "unsupported_version"` with a
`versionStatus`; future and unknown versions are acknowledged without current-schema dispatch.
Older signed payloads retain the narrow structural compatibility dispatch the adapter previously
accepted. Missing or empty version fields remain invalid payloads.

For `message.received`, the result exposes the event/partner/trace envelope,
transport verification scheme, provider message and chat IDs, direct/group
state, receiving and remote endpoints, owner/sender handles, service,
timestamps, parts, attachments, and reply context. `rawEvent` is a detached,
immutable snapshot of the complete authenticated envelope, so public
observation cannot alter later dispatch. `rawBody` preserves the decoded authenticated JSON text and
`rawBodyBase64` preserves the exact authenticated bytes for durable ingress. Existing Chat SDK `Message.raw`
remains the mutable Linq message data object, preserving current consumer
behavior.

Current `message.sent`, `message.delivered`, and `message.read` callbacks expose curated message/chat
correlation, actual and preferred service, idempotency key, and sent/delivered/read/reconciliation
timestamps.
`message.failed` exposes nullable message/chat correlation, numeric provider code, opaque detail
code, reason, actual/preferred service, and failure timestamp. The authenticated trace remains on
`event.envelope.traceId`; every callback retains the complete immutable `rawEvent`.

`message.edited` confirms one text-part edit with message/chat IDs, sender, direction, zero-based
part index, replacement text, and edit time. The event is not a full message snapshot. Use its
provider message ID with `adapter.fetchMessage()` or `adapter.client.messages.retrieve()` when a
current snapshot is needed; a deleted message may return no result. The retrieval schema has no
edit timestamp, so the adapter does not infer an edit merely because `updated_at` changed.

When a `message.received` payload has `reconciled_at`, it is genuine recovered history that may
arrive after earlier webhook or history reads. It remains available through `onLinqEvent()` and the
verified raw/normalized observations, but it does not enter ordinary Chat SDK new-message handlers.
Applications decide whether and how to merge refreshed, edited, and reconciled observations.

### Inbound and history fidelity

Verified `message.received` events expose immutable typed observations for reply context, actual and
preferred service, message effects, text decorations, per-part reactions, reconciled time, and
inbound sticker metadata. Each part also retains its complete authenticated `raw` value, and the
verified webhook retains the complete `rawEvent`. Standard Chat SDK messages map only faithful
cross-platform facts such as canonical identity, author, text, links, and attachments; Linq effects,
service choice, decorations, part targeting, and stickers remain provider observations rather than
invented standard fields.

Retrieved messages retain the official SDK response in `Message.raw`. Null, malformed, and unknown
individual parts do not discard valid sibling content; `parts: null` produces a usable empty message
row. History skips only rows without enough canonical identity to construct a message and preserves
the order and cursor of every usable normal or tombstone row.

`thread.messages` uses Chat SDK's default backward iterator: the adapter preserves endpoint row order
within each page and Chat SDK reverses that page for iteration. Linq's chat-history endpoint has no
safe forward-pagination contract in the installed SDK, so explicit forward fetches—and therefore
`thread.allMessages`—throw `NotImplementedError` instead of simulating a cursor with unsupported
ordering guarantees. These behaviors are `Contract-verified`; the adapter makes no provider ordering,
delivery, or recipient-presentation guarantee.

The adapter does not derive retry safety, ordering, conflict resolution, or a terminal delivery
state from these events.
Linq documents code-specific recovery guidance, and a `message.delivered` event can rarely follow
`message.failed` for the same message. SMS/MMS also do not produce delivered/read receipts. Treat
callbacks as authenticated observations and keep application workflow policy outside the adapter.

These values are authenticated provider observations, not durable application
identity. Applications remain responsible for identity resolution,
persistence, deduplication, routing, authorization, and execution policy.

## Configuration

| Option                    | Required | Description                                                                                      |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `apiKey`                  | yes      | Linq API key used for outbound/native API calls.                                                 |
| `signingSecret`           | yes      | Subscription signing secret used only by the adapter-owned inbound verifier.                     |
| `webhookVerificationMode` | no       | `"standard"` (default) or deprecated explicit `"legacy"` mode for a known existing subscription. |
| `baseURL`                 | no       | Override the Linq API base URL (for example, sandbox).                                           |

Standard mode requires all three Standard headers. Legacy-only requests fail. Legacy mode requires
the legacy signature headers. Any partial Standard header set fails in both modes. When both sets
are complete, the configured mode is authoritative; a failed authoritative signature never falls
back to the other scheme.

To migrate an existing legacy subscription, create or rotate to a Standard Webhooks subscription,
store its one-time `whsec_` secret, switch the adapter to the default Standard mode, and verify real
provider deliveries before deleting the old subscription. Legacy support can be removed after all
known deployments have migrated and Linq documents or confirms that no active subscription still
requires the deprecated headers.

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

The canonical OpenAPI evidence reverified on 2026-08-19 contains 68 callable operations, 56 webhook
example operation IDs, and 45 event names (124 operation IDs total). The checked-in inventory and
`pnpm openapi:check` detect drift. The installed `@linqapp/sdk@0.42.0` covers native operations but
its empty generated `Webhooks` resource contradicts documentation that still describes
`webhooks.unwrap()`; inbound authentication and envelopes therefore remain adapter-owned.

Proactive sending is intentionally not adapter behavior: `chat.openDM()` remains unsupported for
Linq. Reduced Batch `004` documents and validates the native-client create/send operation followed
by canonical Chat SDK thread construction; it adds no provisional IDs, aliases, locks, or proactive
adapter wrapper.

See [`FEATURE_PARITY.md`](./FEATURE_PARITY.md) for the authoritative capability status
of every Linq endpoint, message feature, and webhook, including its architectural
disposition, limitations, priority, definition of done, test coverage, recipes,
and independently reviewable batch. Batches `011` and `012` are deferred; Batch `013` is later
inventory reconciliation and cleanup. `Complete` means the adapter-owned implementation,
contracts, tests, and documentation are complete. Provider, device, and host observations use the
separate evidence labels defined in the parity matrix and are not universal completion gates.

The extension surface is intentionally small: `onLinqEvent()` registration for verified generic
events, the implemented `linqMessage(content, options)` send-time transport, and the cohesive
`adapter.conversation(threadOrId)` facade. Part-specific reply/reaction behavior is implemented;
the frozen common, `.group`, and `.location` contracts are implemented.
Endpoint-shaped account and administrative behavior remains on `adapter.client`.

## Supported features

| Feature                                            | Status                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Inbound text messages                              | ✅                                                                                                            |
| Outbound text messages                             | ✅ to existing chats                                                                                          |
| Group chats                                        | ✅ reply to existing groups received via webhook                                                              |
| Inbound media (images, audio, files)               | ✅ parsed as attachments with downloadable data                                                               |
| Outbound media / file sending                      | ✅ to existing chats; `attachments` and `files` become media parts                                            |
| Inbound reactions (tapbacks + custom emoji)        | ✅ dispatch to `onReaction()`                                                                                 |
| Outbound reactions (add/remove)                    | ✅                                                                                                            |
| Rich link previews                                 | ✅ standalone `linqMessage("", { richLink })`; request contract only                                          |
| Standard replies                                   | ✅ `thread.reply(messageOrId, content)`                                                                       |
| Part-specific replies/reactions                    | ✅ `adapter.conversation(threadOrId)` with explicit zero-based indexes                                        |
| Common/group/location facade                       | ✅ typed common, voice, existing-group, and location operations                                               |
| Mark as read                                       | ✅ `thread.markAsRead(messageOrId)`; Linq marks the whole chat                                                |
| Edit message                                       | ✅ text, first part only                                                                                      |
| Fetch message / history / thread                   | ⚠️ defensive backward cursor history; forward/`allMessages` is explicitly unsupported                         |
| Typing indicators                                  | ✅ direct/group `thread.startTyping()`; acknowledgement only, with host-owned refresh cadence                 |
| Webhook signature verification + replay protection | ✅                                                                                                            |
| Two-phase verified webhook ingress                 | ✅ `2026-02-03` typed facts + optional Chat SDK dispatch                                                      |
| Generic Linq event registration                    | ✅ verified one/many/all delivery, atomic dedupe, callback isolation, and non-blocking `waitUntil` scheduling |
| Streaming                                          | ⚠️ buffered to one compiled final send; no native streaming claim                                             |
| Sticker reactions                                  | ⚠️ typed inbound/raw observation; skipped by standard reaction dispatch                                       |
| Delete message                                     | ❌ Linq cannot unsend on the recipient's device                                                               |
| `openDM()` / proactive adapter sending             | ❌ intentionally unsupported; use the reduced Batch `004` native-client recipe                                |
| Cards                                              | ⚠️ flattened to plain text + image media parts — buttons/selects show labels but cannot trigger `onAction()`  |
| Modals, slash commands                             | ❌ no Linq equivalent                                                                                         |

## Proactive sending

The adapter posts only to canonical existing-chat thread IDs (`linq:{chatId}`). It intentionally
does not implement `openDM()` or create a Linq chat behind `thread.post()`.

Applications that need proactive sending today can use the configured official client directly.
Use `messages.create()` when Linq should auto-select the sending number. Construct a Chat SDK thread
only after that operation returns its canonical `chat_id`:

```ts
import { randomUUID } from "node:crypto";

const logicalSendId = randomUUID();
const result = await adapter.client.messages.create({
  to: [recipient],
  message: {
    idempotency_key: logicalSendId,
    parts: [{ type: "text", value: "Hello from Linq" }],
  },
});

const thread = chat.thread(`linq:${result.chat_id}`);
await thread.subscribe();
await thread.post("A normal follow-up through Chat SDK");
```

Retain and reuse `logicalSendId` if that logical initial send must be retried; generate a new value
for each distinct intentional send. Never reuse a key across separate intended messages.

When the application must choose the sending number explicitly, use
`adapter.client.chats.create()` and follow the official client's initial-message constraints:

```ts
import { randomUUID } from "node:crypto";

const logicalSendId = randomUUID();
const result = await adapter.client.chats.create({
  from: sendingLine,
  to: [recipient],
  message: {
    idempotency_key: logicalSendId,
    parts: [{ type: "text", value: "Hello from the selected Linq line" }],
  },
});

const thread = chat.thread(`linq:${result.chat.id}`);
await thread.subscribe();
await thread.post("A normal follow-up through Chat SDK");
```

These calls retain the official client's native request, response, validation, error, and retry
behavior; they do not create a Chat SDK thread automatically. Linq currently documents fixed-line
reuse by the explicit `from` plus exact `to` set, with named groups, changed participants, and a
departed sending line among the cases that can produce a new chat. That creation/reuse behavior is
provider-owned and is not exercised or guaranteed by this adapter recipe.

Do not create a recipient-derived provisional ID or Thread before the native call succeeds. Chat
SDK Thread identity is immutable, so a provisional Thread cannot adopt the returned Linq chat ID.
Posting through it later can repeat creation, while subscriptions and state remain attached to a
different identity. The adapter therefore provides no `openDM()`, provisional thread, recipient
alias, identity migration, hidden first-send transport, lock, persistence scheme, or failover
wrapper.

The compile-time recipe contract verifies the installed native request/response shapes, the
different `result.chat_id` and `result.chat.id` return paths, post-success canonical thread
construction, later ordinary Chat SDK operations, immutable Thread identity, and absence of
`LinqAdapter.openDM()`. Linq owns and this batch does not verify auto-line selection, creation versus
reuse, same-key deduplication, concurrency, failover, delivery, or service/device presentation.

Batch `004A` is `Documented` and `Contract-verified` through recipe/compile-time contracts.
Selective sandbox observations of new creation, active-chat reuse, same-key retry, failover, or
concurrent distinct intentional sends are optional `004B` provider evidence and remain incomplete.
`004A` adds no runtime adapter behavior, first-send lock, identity migration, or Chat SDK change. See
[Batch `004` proactive native-client recipe](./FEATURE_PARITY.md#batch-004-proactive-native-client-recipe).

## Recipes

Recipes compose the native client with adapter-provided chat primitives; they do
not add workflow-specific adapter methods or appear in implementation batches.

### Accept payments over chat (recipe primitives available)

Create and manage a Payment Request with
`adapter.client.paymentRequests`, send its `checkout_url` through the general
rich-link message capability, and observe `payment.succeeded`,
`payment.canceled`, or `payment.expired` through generic typed
`adapter.onLinqEvent(...)`. Application code owns reconciliation and payment
state. The native client, general rich-link delivery, and generic event passthrough primitives are
available; no payment-specific adapter API, reconciliation, or workflow guarantee is implied.

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
Linq's 100MB attachment ceiling. Audio posted through standard Chat SDK files is
sent as a downloadable attachment. For Linq's dedicated voice-memo request,
use `adapter.conversation(threadOrId).sendVoiceMemo()` with a public HTTPS URL
or an existing Linq attachment ID as documented above.

Batch `012` retains streaming upload work, readiness, upload retries, complete
format handling, retention, and all send-time cleanup. Existing inbound
download security/bounding and the by-reference public-HTTPS behavior above
remain implemented; Batch `012` must not regress them.

## Cards

iMessage/SMS has no Chat SDK card transport, so [cards](https://chat-sdk.dev/docs/cards) are
deterministically flattened to plain text and image media instead of being dropped. This is not a
native-card or interactive-card claim:

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

## Optional live smoke evidence

`smoke-live.mjs` provides a guarded plan/apply workflow against the **real Linq API**. Run
`pnpm build` first because it imports `./dist`. Every command is plan-only until `--apply` is
supplied; plans and results fingerprint all provider identifiers and handles.

This smoke is optional compatibility evidence, not an ordinary development or release gate. Revisit
provider-produced webhook compatibility when the signing verifier, `standardwebhooks` dependency,
supported webhook version, Linq signing contract, or a host's raw-body handling materially changes.
Its narrow purpose is to confirm the real Standard Webhooks headers, server-generated signature,
untouched body, versioned envelope, and adapter `2xx` response. It does not prove deduplication,
callback timing, `waitUntil`, database behavior, or Linq delivery reliability. Legacy remains
locally contract-tested unless an actual legacy subscription is being migrated.

`send` and `live` are fixed-line operations. Their provider requests are constructed in
TypeScript-checked source and use `chats.create({ from, ... })`, which creates or reuses the chat
keyed to the exact selected line and recipient. The apply result verifies the returned owner line
before an operator should reply. They never use auto-line `messages.create()`; that operation may
reuse a more recently active chat on another healthy account line.

Get a sandbox number with the [Linq CLI](https://www.npmjs.com/package/@linqapp/cli): `linq signup --phone <your cell>`, then grab the token from `~/.linq/config.json`.

```bash
# Plan one outbound text. This performs no provider operation.
LINQ_API_KEY=<token> LINQ_FROM=<exact development line> LINQ_TEST_TO=<exact recipient> \
  node smoke-live.mjs send

# Apply only after reviewing the redacted plan.
LINQ_LIVE_CONFIRM=SEND_ONE_REAL_TEXT \
  node smoke-live.mjs send --apply

# Plan an echo-free local receiver using an existing Standard Webhooks secret.
LINQ_API_KEY=<token> LINQ_SIGNING_SECRET=<webhook secret> \
  node smoke-live.mjs serve

# Plan one ephemeral end-to-end delivery. The receiver starts before the subscription,
# the subscription is filtered to LINQ_FROM, and deletion runs in finally.
LINQ_WEBHOOK_TARGET_URL=<unique HTTPS tunnel route> \
LINQ_LIVE_RUN_ID=<stable unique run ID> \
LINQ_LIVE_STATE_FILE=<ignored mode-0600 env file> \
  node smoke-live.mjs live
```

| Env                                                   | Mode      | Purpose                                                              |
| ----------------------------------------------------- | --------- | -------------------------------------------------------------------- |
| `LINQ_API_KEY` / `LINQ_API_TOKEN`                     | all       | Linq API token; never printed                                        |
| `LINQ_FROM` / `LINQ_TEST_TO`                          | send/live | Exact E.164 development line and recipient; output is fingerprinted  |
| `LINQ_SIGNING_SECRET` / `LINQ_WEBHOOK_SIGNING_SECRET` | serve     | Existing Standard Webhooks signing secret                            |
| `LINQ_WEBHOOK_TARGET_URL`                             | live      | Unique HTTPS route; version and unique run ID are added              |
| `LINQ_LIVE_RUN_ID`                                    | live      | Stable unique run identifier used by both plan and apply             |
| `LINQ_LIVE_STATE_FILE`                                | live      | Ignored mode-0600 env file for immediate one-time-secret persistence |
| `LINQ_BASE_URL` / `LINQ_API_BASE_URL`                 | all       | Current SDK base URL override                                        |
| `LINQ_LIVE_CONFIRM`                                   | apply     | Exact confirmation printed by the reviewed plan                      |

`send --apply` performs exactly one fixed-line text send. `serve --apply` never echoes. `live --apply` starts
the local receiver first, creates an exact-line-filtered subscription for only `message.received`
and `message.sent`, persists the one-time secret immediately, sends one text, verifies a
provider-produced delivery, and deletes the subscription in `finally`. If deletion fails, the
private state file retains the recovery identifiers for deterministic manual cleanup. The live
mode does not initialize a production state backend, register generic callbacks, pass `waitUntil`,
or replay a delivery, so do not cite it as evidence for those behaviors.

## License

[Apache-2.0](../../LICENSE)
