# Nitro example application

This example runs a Chat SDK bot with Linq, WhatsApp, and Telegram adapters.

```bash
pnpm install
pnpm --filter nitro-starter dev
```

Build it with:

```bash
pnpm --filter nitro-starter build
```

## Webhooks

The WhatsApp route is `/api/webhooks/whatsapp`; configure the corresponding Meta credentials and
verification token in the environment.

The Linq route is `/api/webhooks/linq`. It preserves the incoming body and delegates Standard
Webhook verification and ordinary dispatch to the Linq adapter. Configure a Standard Webhooks
`whsec_` signing secret. The application may record observations for its own product needs, but
durable queues, persistence, replay, rate limiting, and deployment policy are host/application
responsibilities rather than adapter guarantees.

Linq implements the standard `thread.markAsRead(message)` call as a chat-wide acknowledgement.
