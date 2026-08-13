---
name: integrating-linq
description: Integrates the Linq Partner API for webhook intake, subscription setup, verified event handling, and Chat SDK adapter work. Use when building Linq webhook routes, verifying signatures, storing inbound events, or sending messages through Linq.
---

# Integrating Linq

Use this workflow when changing Linq integration or `packages/adapter-linq`. Provider facts below
were reverified on **2026-08-13**; recheck current sources before relying on versioned schemas,
operations, event names, limits, or delivery behavior.

## Evidence precedence

Resolve conflicts in this order:

1. Current official Linq documentation and canonical OpenAPI.
2. Installed official SDK types and runtime behavior.
3. Current repository implementation/tests and `packages/adapter-linq/FEATURE_PARITY.md` status.
4. This skill's summaries and examples.

Record discrepancies instead of inventing behavior. OpenAPI capability does not imply that the
installed SDK exposes it, and a generated SDK union may lag current provider events.

## Current primary sources

Start at:

- `https://docs.linqapp.com/llms.txt` — current documentation index;
- `https://docs.linqapp.com/guides/webhooks/` — verification, versioning, and delivery guarantees;
- `https://docs.linqapp.com/guides/webhooks/events/` — envelope and event examples;
- `https://docs.linqapp.com/guides/webhooks/subscriptions/` — subscription lifecycle;
- `https://docs.linqapp.com/guides/messaging/` — message behavior;
- `https://docs.linqapp.com/getting-started/sdks/` — official client behavior; and
- `https://cdn.linqapp.com/openapi/linq-api-v3.yaml` — canonical endpoints, schemas, and event enum.

Use the index to discover current page paths rather than guessing old documentation URLs.

## Repository entry points

Inspect the applicable files before changing behavior:

- `packages/adapter-linq/src/verification.ts`
- `packages/adapter-linq/src/webhook.ts`
- `packages/adapter-linq/src/adapter.ts`
- `packages/adapter-linq/test/verified-webhook.test.ts`
- `packages/adapter-linq/test/adapter.test.ts`
- `packages/adapter-linq/FEATURE_PARITY.md`
- `apps/api/server/lib/linq-api.ts`
- `apps/api/server/lib/database.ts`
- `apps/api/server/api/linq/setup/webhook.post.ts`
- `apps/api/server/api/webhooks/linq.post.ts`

## API and subscription facts

- API base URL: `https://api.linqapp.com/api/partner`; V3 resources live below `/v3`.
- Authentication: `Authorization: Bearer <token>`; prefer the installed official client.
- Create subscriptions with `POST /v3/webhook-subscriptions`.
- Each `target_url` must be unique per account.
- The create response reveals `signing_secret` once; persist it securely immediately.
- Pin the payload with `?version=2026-02-03` while that remains the current documented version.

## Signature verification

Preserve the exact raw request body bytes. Never parse and reserialize before verification.

### Standard Webhooks — recommended/current path

Current deliveries include:

- `webhook-id`
- `webhook-timestamp`
- `webhook-signature`

The signed content is:

```text
{webhook-id}.{webhook-timestamp}.{raw_body}
```

The official SDK's `webhooks.unwrap()` verifies this scheme. Standard secrets use the `whsec_`
format, and signatures use `v1,{base64}` values. Reject timestamps outside the five-minute replay
window and use constant-time signature comparison when implementing verification manually.

### Legacy compatibility

Linq still sends deprecated `X-Webhook-*` headers for existing integrations:

- `X-Webhook-Event`
- `X-Webhook-Subscription-ID`
- `X-Webhook-Timestamp`
- `X-Webhook-Signature`

Their legacy signature is hex HMAC-SHA256 over `{timestamp}.{raw_body}`. Treat this only as
compatibility behavior. The current adapter accepts legacy-only deliveries and deliberately verifies
complete dual-header deliveries with the legacy scheme for compatibility with existing subscription
secrets. A partial Standard header set must not downgrade to legacy verification.

Both paths preserve raw bytes and enforce a five-minute timestamp window. Follow the adapter tests
when changing compatibility behavior; do not silently remove or broaden it.

## Delivery and acknowledgement

Linq's delivery model is at-least-once. Return a successful `2xx` quickly and move asynchronous work
to the host lifecycle where possible. Failed deliveries receive up to 10 attempts over roughly 25
minutes with exponential backoff. Linq retries `5xx`, `429`, connection timeouts, and connection
refusal; ordinary `4xx` responses other than `429` are not retried. Deduplicate by authenticated
event identity and make processing idempotent.

## Versioned webhook shape

For `webhook_version: "2026-02-03"`, the common envelope includes `api_version`,
`webhook_version`, `event_type`, `event_id`, `created_at`, `trace_id`, `partner_id`, and `data`.

Message events use `MessageEventV2`: `direction` is `"inbound"` or `"outbound"`, `sender_handle`
identifies the sender, `chat` contains canonical chat facts including `id`, `is_group`, and
`owner_handle`, and message fields such as `id`, `parts`, `sent_at`, `delivered_at`, and `read_at`
live directly on `data`.

The installed `@linqapp/sdk@0.32.1` `UnwrapWebhookEvent` union currently has 18 variants, while the
OpenAPI enum reverified on 2026-08-13 has 44 event names. Recount from current sources when this
matters. Never treat `UnwrapWebhookEvent` as exhaustive or discard a verified unknown/future event;
preserve the complete authenticated envelope.

Read `reference/webhooks.md` for the repository-specific ingress and setup checklist.
