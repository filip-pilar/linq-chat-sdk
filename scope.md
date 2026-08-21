# Linq adapter scope

The adapter is a reusable, application-neutral translation between Chat SDK and Linq. Its current
capability status is maintained in
[`packages/adapter-linq/FEATURE_PARITY.md`](packages/adapter-linq/FEATURE_PARITY.md).

## Adapter-owned

- Standard Chat SDK operations for existing chats: post, reply, edit, history, refresh, reactions,
  typing, mark-read, cards, files, attachments, and buffered streams.
- Canonical `linq:{chatId}` identity and decode-only compatibility for persisted
  `linq:{chatId}:dm/group` values.
- Deterministic text/decoration compilation, service/effect policy, native rich links, outbound
  media preparation, inbound media downloads, shared error translation, and defensive parsing.
- Standard Webhook verification over the exact raw body, stable typed/lossless observations,
  current message/reaction dispatch, atomic event dedupe, callback isolation, and Chat SDK
  `waitUntil` integration.
- A narrow `adapter.conversation(threadOrId)` extension for part-targeted replies/reactions,
  stop-typing, contact-card sharing, voice memos, existing-group operations, and location.
- A read-only `adapter.client` escape hatch for official Linq SDK operations that do not need an
  adapter abstraction.

## Deliberate limits

- `openDM()` is unsupported. Proactive sends use `adapter.client.messages.create()` or an
  intentionally fixed-line `adapter.client.chats.create()`, followed by canonical Chat SDK thread
  construction from Linq's returned chat ID.
- The adapter does not own provider delivery, ordering, retries beyond the SDK, account
  administration, capability discovery, workflow state, databases, durable queues, polling,
  retention/deletion policy, transcription, or request-to-event correlation.
- HTTP request-size limits, rate limiting, availability policy, and deployment lifecycle belong to
  the host/proxy.
- A malformed `message.received` event without a canonical or previously learned chat kind remains
  available through verified raw observation but is not guessed, looked up, or sent to the wrong
  standard handler.
- Inbound voice memos are ordinary downloadable audio attachments. Linq's current schema does not
  reliably distinguish them from other audio media.
- Current history traversal is backward-only and bounded. It skips a bounded number of malformed
  empty provider pages so usable later messages are not hidden.

## Deferred possibilities

- iMessage app-message support remains deferred (`011`).
- Accepting raw Chat SDK `FileUpload` as a third voice-memo source is optional (`012A`). Large-file
  streaming requires demonstrated need; upload workflows and retention remain out of scope.
- Curated group/presence event models remain deferred (`013C`); lossless generic events remain
  available.

These are not active roadmap commitments. Provider/device/live observations are optional evidence,
not adapter completion or release gates.
