# Nitro starter

Create your API and deploy it anywhere with this Nitro starter.

## Getting started

```bash
pnpm install
pnpm --filter nitro-starter dev
```

## WhatsApp webhook

This app exposes the Chat SDK WhatsApp webhook at:

```text
https://your-domain.com/api/webhooks/whatsapp
```

Configure that URL in Meta under **WhatsApp > Configuration**, set the verify token to
`WHATSAPP_VERIFY_TOKEN`, and subscribe to the `messages` webhook field. The same endpoint handles
Meta's `GET` verification challenge and `POST` event delivery.

Required environment variables:

```bash
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_APP_SECRET=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_BOT_USERNAME=... # optional, defaults to whatsapp-bot
WHATSAPP_API_URL=...      # optional, overrides Meta Graph API URL
```

## Deploying

```bash
pnpm --filter nitro-starter build
```

Then checkout the [Nitro documentation](https://v3.nitro.build/deploy) to learn more about the different deployment presets.

## Linq webhook and read receipts

New Linq subscriptions use Standard Webhooks verification by default. The example application calls
the standard Chat SDK `thread.markAsRead(message)` API; Linq implements this as a chat-wide read
acknowledgement. Legacy Linq subscriptions require explicit adapter
`webhookVerificationMode: "legacy"` while they are migrated to a Standard `whsec_` subscription
secret. The application never falls back from failed Standard verification to legacy verification.

The example route's post-dispatch database write is an observability aid, not the adapter's durable
ingress pattern. Production workflows that require replayable side effects should verify, commit or
enqueue the authenticated observation, and only then call `dispatchVerifiedWebhook()` as documented
in the adapter README.
