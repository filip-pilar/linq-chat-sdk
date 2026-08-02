# Linq adapter scope

This file tracks what is still left in the Linq Chat SDK adapter.

Keep this readable and practical: each item should say what is missing, why it matters, and any Linq-specific caveats.

## Current adapter status

The adapter can already handle the core receive/reply path:

- Verify signed Linq webhooks.
- Convert inbound `message.received` events into Chat SDK messages.
- Send reliable text/media/card replies through `thread.post()` to an existing Linq chat, with central limits, one UUID idempotency key, SDK-owned message retries, shared errors, and preparation-only attachment cleanup.
- Fetch thread metadata with `chats.retrieve()`.
- Fetch recent chat history with `chats.messages.list()`.
- Fetch a single message with `messages.retrieve()`.
- Edit text messages with `messages.update()`.
- Render formatted Chat SDK content as markdown text.
- Add and remove reactions with `messages.addReaction()`.
- Route inbound `reaction.added` / `reaction.removed` webhooks into Chat SDK `onReaction()` handlers (tapbacks map to normalized emoji, custom emoji pass through, stickers are skipped).
- Encode stable Linq thread IDs (`linq:{chatId}`) so webhook and API paths map to the same thread.
- Track direct-message vs group-chat identity in-memory from webhooks and chat fetches (legacy `linq:{chatId}:dm/group` IDs still decode).
- Resolve unknown chat identity via `chats.retrieve()` before dispatching webhooks that omit `is_group`.
- Skip typing indicators for known group chats and ignore Linq's expected group-chat typing rejection.
- Show typing indicators for direct-message chats.
- Automatically subscribe and respond to inbound Linq group chats received through webhooks.
- Render Chat SDK cards as a native equivalent: plain text (markdown stripped, links/fields/tables/action labels preserved) plus real image media parts.

## Work still left

### 1. Richer inbound message parsing

Status: **basic but useful**

Current parsing handles:

- text parts
- URLs in text as Chat SDK links
- link parts as text and Chat SDK links
- media-only messages with useful attachment summary text
- media parts as Chat SDK attachments with downloadable data
- Linq reply metadata preserved on `message.raw.reply_to`
- sender identity
- basic sent timestamp
- edited metadata when using retrieved/listed message payloads

Covered by adapter tests:

- text message parsing
- URL extraction from text
- link part parsing
- media attachment parsing
- reply metadata preservation
- edited metadata on retrieved/listed messages
- direct-message/group thread ID detection
- group-safe typing indicators

Still missing:

- first-class normalized reply/thread metadata beyond `message.raw.reply_to`
- edited metadata from edit webhooks, if we subscribe to them later
- delivered/read status in a normalized Chat SDK surface
- reactions on inbound message parts
- richer link preview metadata beyond the URL

### 2. Outbound attachments and media

Status: **existing-chat send path implemented; full media lifecycle remains partial**

`postMessage()` maps Chat SDK `attachments` and `files` to Linq media parts:

- Public HTTPS URLs ≤ 10MB are sent by reference (Linq downloads on send) — no upload round-trip, so forwarding inbound Linq media is free.
- Raw bytes, non-HTTPS URLs, and files > 10MB are pre-uploaded via `POST /v3/attachments` (up to 100MB) and sent by `attachment_id`.
- Messages can be media-only (no text); text leads the parts array so ordering is `[text, media, ...]`.
- Existing-chat sends centrally enforce non-empty content, 10,000 text characters, 100 total parts, 40 public-URL media parts (including card images), valid HTTPS URL parts, 1–255-character upload filenames, and 1-byte–100MB uploads before Linq side effects where the required data is already available.
- Each `postMessage()` call generates one UUID `idempotency_key`; the official Linq SDK owns message retries.
- Attachment creation disables SDK retries. Attachments created during preparation are deleted best-effort only when preparation fails before message sending begins; the primary error is preserved.
- Linq failures map to standard `@chat-adapter/shared` errors while retaining the original Linq error, provider code, trace ID, and applicable retry-after data.

Inbound attachments survive queue serialization via `rehydrateAttachment` and a stable Linq attachment ID.

Still missing:

- iMessage voice-memo bubbles (`POST /v3/chats/{chatId}/voicememo`) — audio currently sends as a downloadable file attachment
- Batch `012` media lifecycle: URL-download security/bounding, streaming, readiness, upload retries, complete format handling, retention, and all send-time cleanup

### 3. Inbound reaction webhooks

Status: **implemented**

Outbound add/remove reactions work, and inbound `reaction.added` / `reaction.removed` webhooks now dispatch into `chat.processReaction()`.

Linq-specific notes:

- Standard tapbacks (like, dislike, love, laugh, emphasize, question) map to normalized Chat SDK emoji.
- Custom emoji reactions resolve through the default emoji resolver, falling back to the raw emoji.
- Sticker reactions are skipped — Chat SDK has no emoji equivalent.
- Reaction webhooks missing `chat_id` or `message_id` are acknowledged but not dispatched.

### 4. Proactive direct-message sending

Status: **unsupported today; assigned to future Batch `004`**

The adapter currently sends only to canonical existing-chat thread IDs (`linq:{chatId}`). Chat SDK
`openDM()` returns a thread before the caller posts content, while Linq creates or reuses a chat only
as part of an initial-message send. Batch `004` owns a future standard Chat SDK proactive path, but
it must not be implemented until that semantic mismatch has a safe design.

Applications that need proactive sending now can use the official client exposed as
`adapter.client`: use `messages.create()` for an auto-selected sending number or `chats.create()`
when the application must select the sending number. Those calls retain native Linq semantics and
do not create a Chat SDK thread automatically. Do not add bespoke adapter `sendMessage()` or
`createChat()` wrappers.

Before implementation, Batch `004` must resolve canonical thread identity and compatibility,
concurrent first-send/idempotency safety, verified initial-message constraints, sender
selection/failover, pre-send and post-send thread behavior, and contract plus sandbox/device
coverage. The complete authoritative acceptance gates are in
[`FEATURE_PARITY.md`](./packages/adapter-linq/FEATURE_PARITY.md#batch-004-proactive-send-design-gate).

## Intentional adapter boundaries

These capabilities remain outside bespoke adapter APIs. Endpoint-shaped operations that the
official Linq client already exposes stay on read-only `adapter.client`.

### Starting new group chats

Linq group chats also require chat creation semantics and an initial message.

Fixed-line group creation remains available through `adapter.client.chats.create()`. Batch `004`
covers a future standard proactive direct-message path, not a bespoke group `createChat()` API;
Batch `009` owns typed management of existing groups.

Existing group chats received through webhooks are still parsed, automatically subscribed, replied to with `postMessage()`, and detected as non-DM threads.



### Delete messages

Linq's delete endpoint only deletes the message from the Linq API.

It does **not** unsend or remove the message from the recipient's chat.

Because Chat SDK callers usually expect `deleteMessage()` to remove the visible chat message, implementing this directly would be misleading.

Only revisit if product explicitly accepts the narrower Linq semantics.



### Native streaming

Linq does not have native streaming message support.

The adapter should keep buffering stream text and posting once.

Chat SDK fallback streaming via edits is technically possible now that `editMessage()` exists, but Linq edit limits make long streaming risky.

Do not turn fallback streaming on by default.



### Channel and thread listing APIs

Linq does not have the same channel/thread split that platforms like Slack have.

Do not implement channel-level APIs or generic thread listing unless the app has a concrete product need.



### Interactive chat UI surfaces

Linq does not provide equivalents for Chat SDK modals, app home, slash commands, or tappable buttons/selects.

Do not implement modal/action/slash-command/app-home APIs for this adapter.

Cards are the exception: they are **not** dropped. `postMessage()` flattens a card to plain text plus image media parts (see "Current adapter status"), so bots that post cards still show up in chat. The non-interactive parts render faithfully; buttons and selects render their labels only — `onAction()` never fires from Linq, so there is no action dispatch to implement.



### Ephemeral and scheduled messages

Linq does not expose native ephemeral or scheduled message semantics that match Chat SDK expectations.

Do not implement these unless Linq adds matching primitives.
