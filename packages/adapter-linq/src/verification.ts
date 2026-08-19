import { Buffer } from "node:buffer";
import { Webhook, WebhookVerificationError } from "standardwebhooks";

import {
  failure,
  type LinqWebhookTransportObservation,
  type LinqWebhookVerificationFailure,
  type LinqWebhookVerificationScheme,
} from "./webhook.js";

const STANDARD_ID_HEADER = "webhook-id";
const STANDARD_SIGNATURE_HEADER = "webhook-signature";
const STANDARD_TIMESTAMP_HEADER = "webhook-timestamp";
const LEGACY_EVENT_HEADER = "x-webhook-event";
const LEGACY_SIGNATURE_HEADER = "x-webhook-signature";
const LEGACY_SUBSCRIPTION_HEADER = "x-webhook-subscription-id";
const LEGACY_TIMESTAMP_HEADER = "x-webhook-timestamp";
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
  scheme: LinqWebhookVerificationScheme,
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

  if (scheme === "standard" && !hasCompleteStandardHeaders) {
    return failure("missing_signature_headers", 401, "Missing Standard Webhook headers");
  }

  return scheme === "standard"
    ? verifyStandardWebhook(request, signingSecret)
    : verifyLegacyWebhook(request, signingSecret);
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
      transport: transportObservation(request.headers, "standard"),
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

async function verifyLegacyWebhook(
  request: Request,
  signingSecret: string,
): Promise<LinqWebhookAuthenticationResult> {
  const timestamp = request.headers.get(LEGACY_TIMESTAMP_HEADER)?.trim() || "";
  const signature = request.headers.get(LEGACY_SIGNATURE_HEADER)?.trim() || "";

  if (!timestamp || !signature) {
    return failure("missing_signature_headers", 401, "Missing Linq webhook signature headers");
  }

  if (!isFreshTimestamp(timestamp)) {
    return failure("stale_timestamp", 401, "Linq webhook timestamp is too old or invalid");
  }

  if (!signingSecret) {
    return missingSigningSecret();
  }

  const rawBytes = new Uint8Array(await request.arrayBuffer());
  const rawBody = new TextDecoder().decode(rawBytes);

  if (!(await verifyLinqSignature(timestamp, signature, signingSecret, rawBytes))) {
    return invalidSignature();
  }

  try {
    const event: unknown = JSON.parse(rawBody);

    return {
      ok: true,
      event,
      rawBody,
      rawBodyBase64: Buffer.from(rawBytes).toString("base64"),
      transport: transportObservation(request.headers, "legacy"),
    };
  } catch {
    return invalidJson();
  }
}

function transportObservation(
  headers: Headers,
  scheme: LinqWebhookTransportObservation["scheme"],
): LinqWebhookTransportObservation {
  return {
    scheme,
    webhookId: trimmedHeader(headers, STANDARD_ID_HEADER),
    timestamp:
      trimmedHeader(
        headers,
        scheme === "standard" ? STANDARD_TIMESTAMP_HEADER : LEGACY_TIMESTAMP_HEADER,
      ) ?? "",
    subscriptionId: trimmedHeader(headers, LEGACY_SUBSCRIPTION_HEADER),
    eventType: trimmedHeader(headers, LEGACY_EVENT_HEADER),
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

function fromHex(hex: string): Uint8Array | null {
  const normalized = hex.startsWith("sha256=") ? hex.slice("sha256=".length) : hex;

  if (normalized.length % 2 !== 0 || /[^a-f0-9]/i.test(normalized)) {
    return null;
  }

  const bytes = new Uint8Array(normalized.length / 2);

  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }

  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;

  for (let index = 0; index < left.length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return mismatch === 0;
}

async function signWebhookPayload(
  secret: string,
  timestamp: string,
  rawBody: Uint8Array,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = encoder.encode(`${timestamp}.`);
  const signedPayload = new Uint8Array(prefix.length + rawBody.length);
  signedPayload.set(prefix);
  signedPayload.set(rawBody, prefix.length);

  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, signedPayload));
}

async function verifyLinqSignature(
  timestamp: string,
  signature: string,
  secret: string,
  rawBody: Uint8Array,
): Promise<boolean> {
  const providedSignature = fromHex(signature);

  if (!providedSignature) {
    return false;
  }

  const expectedSignature = await signWebhookPayload(secret, timestamp, rawBody);
  return constantTimeEqual(providedSignature, expectedSignature);
}
