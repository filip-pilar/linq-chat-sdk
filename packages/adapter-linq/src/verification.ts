import { Buffer } from "node:buffer";
import { Webhook, WebhookVerificationError } from "standardwebhooks";

import {
  failure,
  type LinqWebhookTransportObservation,
  type LinqWebhookVerificationFailure,
} from "./webhook.js";

const STANDARD_ID_HEADER = "webhook-id";
const STANDARD_SIGNATURE_HEADER = "webhook-signature";
const STANDARD_TIMESTAMP_HEADER = "webhook-timestamp";
const MAX_WEBHOOK_AGE_SECONDS = 5 * 60;

export type LinqWebhookAuthenticationResult =
  | {
      readonly ok: true;
      readonly event: unknown;
      readonly rawBody: string;
      readonly rawBodyBase64: string;
      readonly transport: LinqWebhookTransportObservation;
    }
  | LinqWebhookVerificationFailure;

export async function authenticateLinqWebhookRequest(
  request: Request,
  signingSecret: string,
): Promise<LinqWebhookAuthenticationResult> {
  const standardHeaders = [
    STANDARD_ID_HEADER,
    STANDARD_SIGNATURE_HEADER,
    STANDARD_TIMESTAMP_HEADER,
  ];
  const hasAnyStandardHeader = standardHeaders.some((header) => request.headers.has(header));
  const hasCompleteStandardHeaders = standardHeaders.every((header) => request.headers.has(header));
  if (hasAnyStandardHeader && !hasCompleteStandardHeaders) {
    return failure("missing_signature_headers", 401, "Incomplete Standard Webhook headers");
  }

  if (!hasCompleteStandardHeaders) {
    return failure("missing_signature_headers", 401, "Missing Standard Webhook headers");
  }

  return verifyStandardWebhook(request, signingSecret);
}

export async function authenticateTrustedLinqWebhookRequest(
  request: Request,
  verifier: (request: Request, rawBody: Uint8Array) => unknown | Promise<unknown>,
): Promise<LinqWebhookAuthenticationResult> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());

  try {
    const verified = await verifier(request, rawBytes);
    if (verified === false) {
      return invalidSignature();
    }
  } catch {
    return invalidSignature();
  }

  const rawBody = new TextDecoder().decode(rawBytes);
  try {
    return {
      ok: true,
      event: JSON.parse(rawBody) as unknown,
      rawBody,
      rawBodyBase64: Buffer.from(rawBytes).toString("base64"),
      transport: {
        scheme: "trusted_forwarder",
        webhookId: trimmedHeader(request.headers, STANDARD_ID_HEADER),
        timestamp: trimmedHeader(request.headers, STANDARD_TIMESTAMP_HEADER) ?? "",
      },
    };
  } catch {
    return invalidJson();
  }
}

async function verifyStandardWebhook(
  request: Request,
  signingSecret: string,
): Promise<LinqWebhookAuthenticationResult> {
  if (!signingSecret) {
    return missingSigningSecret();
  }

  const rawBytes = new Uint8Array(await request.arrayBuffer());
  const rawBody = new TextDecoder().decode(rawBytes);
  const timestamp = request.headers.get(STANDARD_TIMESTAMP_HEADER)?.trim() || "";

  if (!isFreshTimestamp(timestamp)) {
    return failure("stale_timestamp", 401, "Linq webhook timestamp is too old or invalid");
  }

  try {
    const verifier = new Webhook(signingSecret);
    const event: unknown = verifier.verify(
      Buffer.from(rawBytes),
      Object.fromEntries(request.headers),
    );

    return {
      ok: true,
      event,
      rawBody,
      rawBodyBase64: Buffer.from(rawBytes).toString("base64"),
      transport: transportObservation(request.headers),
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return invalidJson();
    }

    if (!(error instanceof WebhookVerificationError)) {
      return failure("invalid_signing_secret", 503, "Invalid Linq webhook signing secret");
    }

    return invalidSignature();
  }
}

function transportObservation(headers: Headers): LinqWebhookTransportObservation {
  return {
    scheme: "standard",
    webhookId: trimmedHeader(headers, STANDARD_ID_HEADER),
    timestamp: trimmedHeader(headers, STANDARD_TIMESTAMP_HEADER) ?? "",
  };
}

function trimmedHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value || null;
}

function invalidSignature(): LinqWebhookVerificationFailure {
  return failure("invalid_signature", 401, "Invalid Linq webhook signature");
}

function missingSigningSecret(): LinqWebhookVerificationFailure {
  return failure("missing_signing_secret", 503, "Linq webhook signing secret is not configured");
}

function invalidJson(): LinqWebhookVerificationFailure {
  return failure("invalid_json", 400, "Invalid JSON");
}

function isFreshTimestamp(timestamp: string): boolean {
  if (!/^\d+$/.test(timestamp)) {
    return false;
  }
  const sentAt = Number(timestamp);

  if (!Number.isFinite(sentAt)) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - sentAt);
  return ageSeconds <= MAX_WEBHOOK_AGE_SECONDS;
}
