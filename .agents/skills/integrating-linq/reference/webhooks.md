# Linq Webhook Notes

## Current repo behavior

- `POST /api/linq/setup/webhook` creates the minimal Linq subscription for `message.received`
- `POST /api/webhooks/linq?version=2026-02-03` verifies Linq signatures and stores the raw payload in Postgres
- `apps/api/server/lib/database.ts` stores:
  - `linq_webhook_secret` in `app_runtime_settings`
  - `linq_webhook_subscription_id` in `app_runtime_settings`
  - raw deliveries in `linq_webhook_events`

## Subscription checklist

1. Set `LINQ_API_TOKEN` in the API app environment.
2. Ensure `POSTGRES_URL` or `DATABASE_URL` is set.
3. Call:

```bash
curl -X POST http://localhost:3000/api/linq/setup/webhook \
  -H 'content-type: application/json' \
  -H 'x-setup-token: <BOT_SETUP_ACCESS_TOKEN-if-configured>' \
  -d '{"publicBaseUrl":"https://your-public-app.example/"}'
```

4. Linq creates the subscription and returns a one-time `signing_secret`.
5. The setup route persists that secret so the webhook route can verify future deliveries.

## Delivery rules from Linq docs

- Deliveries are HTTP `POST`
- Signed with [Standard Webhooks](https://www.standardwebhooks.com). Headers:
  - `webhook-id`
  - `webhook-timestamp`
  - `webhook-signature`
- Signature input:

```text
{webhook-id}.{webhook-timestamp}.{raw_body}
```

- The key is the base64-decoded signing secret; signatures are compared base64
- Verify with `client.webhooks.unwrap(rawBody, { headers })` rather than
  reimplementing the scheme — it handles the replay window and constant-time
  comparison
- The older `X-Webhook-*` headers are still sent but are deprecated
- `message.received` is the minimal inbound event to subscribe to
- `target_url` can only be used once per account, so change the URL if you need a second subscription

## Latest webhook envelope

The latest documented webhook version is `2026-02-03`.

Common envelope fields:
- `api_version`
- `webhook_version`
- `event_type`
- `event_id`
- `created_at`
- `trace_id`
- `partner_id`
- `data`

For `message.received` on `2026-02-03`, `data` follows `MessageEventV2`:
- `direction`
- `sender_handle`
- `chat`
- `id`
- `parts`
- `sent_at`
- `delivered_at`
- `read_at`

## Good next step for the adapter package

Once raw payload storage is stable, add parsing in `packages/adapter-linq` for:
- `message.received`
- text `parts`
- thread identity from `data.chat.id`
- outbound text replies via the Linq messages API
