# @linqapp/chat-sdk-adapter

## 0.2.0

Released before this package adopted changesets, so this entry is written by
hand from the merged pull requests.

### Minor Changes

- `openDM()` is implemented. It returns a pending thread ID,
  `linq:pending:{handle}`, and the chat is created on that thread's first
  message — Linq has no empty-chat primitive. The ID is deterministic, so a
  handle you have never messaged can be addressed without a round trip, and a
  repeated first post reuses the existing chat rather than starting a parallel
  one. Previously the adapter could only reply to chats that already existed,
  which made proactive sends impossible.

### Patch Changes

- Webhook verification moved to [Standard Webhooks](https://www.standardwebhooks.com).
  The adapter previously read only Linq's legacy `X-Webhook-*` headers and
  hand-rolled an HMAC over `{timestamp}.{raw_body}`. Linq marks those headers
  deprecated and signs with `webhook-id` / `webhook-timestamp` /
  `webhook-signature`, so the old path worked only while both header sets were
  sent. Verification now delegates to `standardwebhooks`, the reference
  implementation.
- Tracks `@linqapp/sdk` `^0.40.0`, up from `^0.22.1`.
- Operations that need an existing chat — fetching messages, editing, typing,
  reactions — now fail on a pending thread with the remedy instead of a
  confusing API error.
