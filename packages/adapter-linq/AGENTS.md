# Linq adapter contributor rules

`FEATURE_PARITY.md` is authoritative for current capability status. Before changing behavior,
reconcile the installed Chat SDK contracts, installed `@linqapp/sdk` types, canonical Linq
OpenAPI/docs, and the repository's `chat-sdk` and `integrating-linq` skills.

## Boundaries

- Implement standard Chat SDK behavior first. Add Linq-specific surface only where a documented
  provider semantic cannot be represented faithfully by Chat SDK or the read-only `adapter.client`.
- Use `@linqapp/sdk` for outbound and native operations. Use `standardwebhooks` and the exact raw
  request body for inbound Standard Webhook authentication.
- Emit canonical `linq:{chatId}` identities. Decode old `linq:{chatId}:dm/group` values only for
  persisted compatibility; do not expose or document them as active identity forms.
- Keep endpoint-shaped account and administrative operations on the official client escape hatch:
  `.client` for static credentials and `await .getClient()` for lazy credentials.
- Preserve released lazy credential rotation, explicit trusted forwarding, proactive `openDM()`,
  `onDeliveryStatus()`, and the `markRead()` compatibility alias while sharing the fork's stronger
  internal machinery. Prefer standard `Thread.markAsRead()` in new examples.
- Validate constraints that prevent adapter-created side effects. Leave provider capabilities and
  provider-enforced policy to Linq rather than adding probes or speculative rules.
- Translate provider failures through shared Chat SDK adapter errors and retain supported Linq
  metadata. Do not duplicate SDK retries or claim delivery from an acknowledgement.
- Validate the minimum runtime SDK response facts needed for public identities and typed results;
  preserve uncertain-acceptance boundaries rather than fabricating facts or retrying mutations.
- Compare provider history by the complete validated RFC3339 instant. Keep JavaScript `Date`
  metadata and immutable full-precision raw values as distinct representations.
- Clean up only resources definitely created and orphaned before message submission; preserve the
  primary error.
- Keep HTTP edge policy, durable queues, persistence, workflows, polling, retention, transcription,
  and deployment lifecycle outside the adapter.

## Change quality

Keep changes application-neutral and independently reviewable. Preserve hostile-input, webhook,
identity, history, media-security, compiler, error, and Chat SDK integration coverage. Update only
durable documentation and affected parity rows. Never make provider/device/live evidence an
ordinary development or release gate.
