---
name: integrating-linq
description: Integrates the Linq Partner API for webhook intake, subscription setup, and future Chat SDK adapter work. Use when building Linq webhook routes, verifying Linq signatures, storing inbound events, or sending messages through Linq.
---

# Integrating Linq

Linq Partner API guide for this repo. Use it when wiring webhook subscriptions, receiving Linq events, or expanding `packages/adapter-linq`.

## Start with the official docs

Read these first:
- `https://apidocs.linqapp.com/llms.txt`
- `https://apidocs.linqapp.com/documentation/getting-started.md`
- `https://apidocs.linqapp.com/documentation/webhooks.md`
- `https://apidocs.linqapp.com/documentation/webhook-events.md`
- `https://apidocs.linqapp.com/documentation/models.md`
- `https://apidocs.linqapp.com/documentation/messages.md`

If you need clarification, use the docs query interface on any `.md` page:

```text
GET https://apidocs.linqapp.com/documentation/webhooks.md?ask=<specific-question>
```

## Repo entry points

Inspect these local files before changing Linq behavior:
- `apps/api/server/lib/linq-api.ts`
- `apps/api/server/lib/database.ts`
- `apps/api/server/api/linq/setup/webhook.post.ts`
- `apps/api/server/api/webhooks/linq.post.ts`
- `packages/adapter-linq/src/index.ts`

## Key facts to preserve

- Base API URL: `https://api.linqapp.com/api/partner`
- Auth: `Authorization: Bearer <token>`
- Minimal webhook subscription body:

```json
{
  "target_url": "https://your-app.example/api/webhooks/linq?version=2026-02-03",
  "subscribed_events": ["message.received"]
}
```

- Create subscriptions with `POST /v3/webhook-subscriptions`
- `target_url` must be unique per account
- The response includes `signing_secret` exactly once, so persist it immediately
- Deliveries are signed with [Standard Webhooks](https://www.standardwebhooks.com). Expect:
  - `webhook-id`
  - `webhook-timestamp`
  - `webhook-signature`
- Verify with `client.webhooks.unwrap(rawBody, { headers })`, which checks the
  signature, enforces the replay window, and parses the envelope in one call.
  Do not hand-roll the HMAC: the signed content is
  `{webhook-id}.{webhook-timestamp}.{raw_body}`, the key is the
  **base64-decoded** secret, and the signature is compared base64. Signing the
  body alone, or keying on the raw secret bytes, rejects every real delivery.
- Linq also still sends the older `X-Webhook-Event`, `X-Webhook-Subscription-ID`,
  `X-Webhook-Timestamp`, and `X-Webhook-Signature` headers. Its API docs mark
  them deprecated, so do not verify against them.
- Return `2xx` quickly; Linq retries `5xx`, `429`, and network failures up to 10 times over about 25 minutes
- `4xx` responses except `429` are not retried
- Pin the latest payload version by appending `?version=2026-02-03` to the webhook URL

## Latest message webhook shape

For subscriptions using `version=2026-02-03`, the webhook envelope includes:
- `api_version`
- `webhook_version`
- `event_type`
- `event_id`
- `created_at`
- `trace_id`
- `partner_id`
- `data`

For `message.received`, `data` uses the latest `MessageEventV2` shape:
- `direction` is `"inbound"` or `"outbound"`
- `sender_handle` identifies the sender
- `chat` contains `id`, `is_group`, and `owner_handle`
- message fields like `id`, `parts`, `sent_at`, `delivered_at`, and `read_at` live at the top level of `data`

Read `reference/webhooks.md` if you need the fuller repo-specific checklist.
