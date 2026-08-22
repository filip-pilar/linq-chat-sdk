# Linq adapter contributor rules

Use [FEATURE_PARITY.md](FEATURE_PARITY.md) for capability status, [README.md](README.md) for consumer
contracts, and the repository [scope](../../scope.md) for ownership. Before changing behavior,
reconcile installed Chat SDK contracts, installed `@linqapp/sdk`, canonical Linq OpenAPI/docs, and
the `chat-sdk` and `integrating-linq` skills.

## Invariants

- Prefer standard Chat SDK behavior. Add Linq-specific API only for a documented semantic gap with
  durable cross-application value.
- Use the official SDK for provider operations and exact raw bytes plus `standardwebhooks` for
  direct webhook authentication. Trusted forwarding must remain explicit and exclusive.
- Emit canonical `linq:{chatId}`; decode legacy `:dm/group` suffixes only for persisted
  compatibility.
- Resolve lazy credentials once per logical operation. Keep static `.client`, universal
  `getClient()`, released `openDM()`, `onDeliveryStatus()`, and `markRead()` compatibility.
- Validate adapter-owned side-effect and public-result facts before credentials, logging, UUIDs,
  media work, or provider I/O where promised. Translate provider failures without inventing retry,
  delivery, or correlation guarantees.
- Preserve exact mention identity, full-precision history ordering, immutable raw facts, bounded
  traversal, media security, definite-orphan cleanup, atomic dedupe, callback isolation, and fast
  acknowledgement.
- Keep account/admin endpoints on the native client and host/application workflow concerns outside
  the adapter.

## Change quality

Keep changes application-neutral and reviewable. Preserve public-path hostile-input, identity,
webhook, history, media, compiler, error, and Chat SDK integration coverage. Update only affected
consumer docs and parity rows. Provider/device/live evidence is supplementary, not a routine gate.
