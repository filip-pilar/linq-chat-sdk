# Linq webhook checklist

Provider facts here were reverified on **2026-08-19**. Start with the current
[`docs.linqapp.com` index](https://docs.linqapp.com/llms.txt),
[webhook guide](https://docs.linqapp.com/guides/webhooks/), and
[canonical OpenAPI](https://cdn.linqapp.com/openapi/linq-api-v3.yaml). Then inspect the resolved
`@linqapp/sdk` types and current repository tests. Record disagreements; do not resolve them from
this summary alone.

## Verification checklist

Always preserve the raw request body until authentication succeeds.

### Standard Webhooks — recommended

- Read `webhook-id`, `webhook-timestamp`, and `webhook-signature`.
- Verify `{webhook-id}.{webhook-timestamp}.{raw_body}` using the subscription secret.
- Standard secrets use `whsec_` plus base64 key material; signatures contain `v1,{base64}` values.
- Reject timestamps outside five minutes and compare signatures in constant time.
- Use the direct `standardwebhooks` reference implementation. The current SDK's `Webhooks` class is
  empty even though provider documentation still describes `webhooks.unwrap()`.

### Legacy compatibility

- Linq still sends deprecated `X-Webhook-Event`, `X-Webhook-Subscription-ID`,
  `X-Webhook-Timestamp`, and `X-Webhook-Signature` headers.
- The legacy signature is hex HMAC-SHA256 over `{timestamp}.{raw_body}`.
- Legacy requires explicit `webhookVerificationMode: "legacy"` for a known existing subscription.
- Standard is the default; legacy-only requests fail in Standard mode.
- Any partial Standard header set fails in both modes.
- Complete dual headers use the configured authoritative mode. Never fall back after verification
  fails under that mode.

Both behaviors are contract-tested in `packages/adapter-linq/test/verified-webhook.test.ts` and
`packages/adapter-linq/test/adapter.test.ts`. Do not infer a provider requirement from the adapter's
compatibility policy.

## Delivery checklist

- Deliveries are HTTP `POST` and at-least-once.
- Pin the target URL to `?version=2026-02-03` while that remains current.
- Return `2xx` quickly; the provider timeout is 10 seconds.
- Use host background-lifetime support such as `WebhookOptions.waitUntil` where applicable.
- Deduplicate using authenticated event identity and make callbacks idempotent.
- Linq retries `5xx`, `429`, connection timeout, and connection refusal up to 10 times over roughly
  25 minutes. Ordinary `4xx` responses except `429`, DNS failures, and invalid hosts are not retried.

## Current adapter ingress

`packages/adapter-linq` already implements signature verification, message/reaction parsing,
existing-chat sends, and two ingress forms:

- `chat.webhooks.linq(request, options?)` / adapter `handleWebhook()` is the ordinary one-step path:
  verify, normalize, dispatch supported standard events, and acknowledge.
- `adapter.verifyWebhook(request)` verifies and normalizes once without dispatch. Applications may
  persist the authenticated observation before calling
  `adapter.dispatchVerifiedWebhook(webhook, options?)` for standard Chat SDK dispatch.

The typed path targets `2026-02-03` and preserves immutable parsed JSON, decoded request text, and
exact authenticated bytes as base64. It returns lossless `unsupported_version` observations for older, future, and unknown
non-empty versions. The ordinary path retains narrow compatibility dispatch for older signed
payloads and acknowledges future/unknown versions without current-schema dispatch. Consult
`packages/adapter-linq/FEATURE_PARITY.md` before describing generic
event callbacks, deduplication, or other planned behavior as implemented.

The checked-in inventory records 68 callable operations, 56 webhook examples, and 45 event names.
Run `pnpm openapi:check` to detect canonical schema drift. `@linqapp/sdk@0.41.1` has no unwrap union;
do not use generated SDK webhook wrappers as a closed-world boundary.

## Repository setup and storage

These current application entry points are separate from the reusable adapter package:

- `apps/api/server/api/linq/setup/webhook.post.ts` creates the minimal `message.received`
  subscription after setup authorization.
- `apps/api/server/lib/linq-api.ts` builds the version-pinned webhook URL and uses the official SDK.
- `apps/api/server/api/webhooks/linq.post.ts` clones the request for storage, invokes the ordinary
  Chat SDK webhook path, and stores successful verified deliveries using host `waitUntil` when
  available.
- `apps/api/server/lib/database.ts` stores the subscription secret/ID in application settings and
  raw deliveries in `linq_webhook_events`.

The setup route requires the application's Linq token and database configuration. Never place API
tokens, signing secrets, real participant identifiers, or environment-specific credentials in
tracked documentation or fixtures.

## Versioned envelope

The `2026-02-03` envelope includes `api_version`, `webhook_version`, `event_type`, `event_id`,
`created_at`, `trace_id`, `partner_id`, and event-specific `data`. Message events use
`MessageEventV2`: `direction`, `sender_handle`, nested `chat`, and top-level message fields such as
`id`, `parts`, `sent_at`, `delivered_at`, and `read_at`.

Before changing parsing, compare the official event guide/OpenAPI, installed SDK declarations,
`packages/adapter-linq/src/webhook.ts`, and current fixtures. Preserve provider facts that cannot be
normalized faithfully in the verified raw envelope.
