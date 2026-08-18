import type { LinqAPIV3 } from "@linqapp/sdk";
import { Webhook } from "standardwebhooks";

export type LinqWebhookVerificationResult =
  | { ok: true; event: LinqAPIV3.UnwrapWebhookEvent }
  | { ok: false; response: Response };

/**
 * Verifies and parses a Linq webhook delivery.
 *
 * Linq signs deliveries with Standard Webhooks (`webhook-id`,
 * `webhook-timestamp`, `webhook-signature`) and still emits the older
 * `X-Webhook-*` headers for backwards compatibility, which its API docs mark
 * deprecated.
 *
 * `standardwebhooks` is the reference implementation of that spec and the same
 * library `@linqapp/sdk` delegates to from `client.webhooks.unwrap`. Calling it
 * here keeps the signing scheme owned by the spec rather than restated in this
 * package, without coupling webhook verification to API credentials — a
 * delivery can be verified with only the signing secret.
 */
export async function verifyLinqWebhookRequest(
  request: Request,
  signingSecret: string,
): Promise<LinqWebhookVerificationResult> {
  if (!signingSecret) {
    return {
      ok: false,
      response: new Response("Linq webhook signing secret is not configured", { status: 503 }),
    };
  }

  const body = await request.text();

  try {
    new Webhook(signingSecret).verify(body, Object.fromEntries(request.headers));
  } catch {
    return { ok: false, response: new Response("Invalid Linq webhook", { status: 401 }) };
  }

  try {
    return { ok: true, event: JSON.parse(body) as LinqAPIV3.UnwrapWebhookEvent };
  } catch {
    return { ok: false, response: new Response("Invalid JSON", { status: 400 }) };
  }
}
