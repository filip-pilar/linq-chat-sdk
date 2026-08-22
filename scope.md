# Linq adapter scope

The adapter is an application-neutral Chat SDK translation. Current capability status and evidence
live in the [compact parity matrix](packages/adapter-linq/FEATURE_PARITY.md); consumer contracts and
examples live in the [package README](packages/adapter-linq/README.md).

## Adapter-owned

- Standard Chat SDK operations, canonical returned identities, pending `openDM()`, and decode-only
  compatibility for persisted legacy IDs.
- Deterministic message compilation, native group mentions, Linq message options, defensive
  parsing, chronological history, media preparation/downloads, and shared provider errors.
- Static/lazy credentials and truthful native-client access.
- Exact Standard Webhook authentication, explicit trusted forwarding, immutable typed/lossless
  observations, atomic dedupe, callback isolation, and `waitUntil`.
- The narrow `adapter.conversation()` surface for part targeting, stop typing, contact-card
  sharing, voice memos, existing groups, location, and polls.

These responsibilities include validation and security required by network or stateful work the
adapter itself performs. They do not imply provider delivery, presentation, or workflow completion.

## Boundary owners

| Owner                 | Responsibilities                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat SDK              | Generic cross-provider thread/message abstractions, routing, and host state contracts                                                             |
| Linq / official SDK   | Provider capability, delivery, retries owned by the SDK, account/admin operations, and opaque upload-host integrity                               |
| Host / infrastructure | Untouched raw request delivery, HTTP size/rate/availability policy, network controls, and request lifecycle                                       |
| Application           | Persistence, queues, polling, correlation, identity/product policy, retention, transcription, vCard/contact handling, AI tools, and authorization |

The adapter does not add capability probes, hidden identity migration, automatic recovery from
uncertain mutation acceptance, provider workflows, or deployment policy.

## Intentional limitations

- `SentMessage.delete()` is unsupported because Linq's native deletion removes only its API record,
  not the recipient-visible message.
- iMessage app messages require an application-owned Messages extension and remain provider-native
  through `adapter.client` / `getClient()`.
- Canonical group, participant, and typing events are authenticated named/raw observations; the
  adapter does not impose a curated conversation-state model.
- Chat backgrounds stay on `adapter.client` / `getClient()` while guidance and request enums
  disagree (`glitter` versus `sky`/`water`/`aurora`).
