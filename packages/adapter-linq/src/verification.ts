const LINQ_SIGNATURE_HEADER = "x-webhook-signature";
const LINQ_TIMESTAMP_HEADER = "x-webhook-timestamp";
const MAX_WEBHOOK_AGE_SECONDS = 5 * 60;

export type LinqWebhookVerificationResult =
  | { ok: true; rawBody: Uint8Array }
  | { ok: false; response: Response };

export async function verifyLinqWebhookRequest(
  request: Request,
  signingSecret: string,
): Promise<LinqWebhookVerificationResult> {
  const rawBody = new Uint8Array(await request.arrayBuffer());

  return verifyLinqWebhookBody(request.headers, signingSecret, rawBody);
}

/**
 * Verifies a Linq signature against an already-read body. This lets adapters
 * support a trusted webhook forwarder without reading the request body twice.
 */
export async function verifyLinqWebhookBody(
  headers: Headers,
  signingSecret: string,
  rawBody: Uint8Array,
): Promise<LinqWebhookVerificationResult> {
  const timestamp = headers.get(LINQ_TIMESTAMP_HEADER)?.trim() || "";
  const signature = headers.get(LINQ_SIGNATURE_HEADER)?.trim() || "";

  if (!timestamp || !signature) {
    return {
      ok: false,
      response: new Response("Missing Linq webhook signature headers", { status: 401 }),
    };
  }

  if (!isFreshTimestamp(timestamp)) {
    return {
      ok: false,
      response: new Response("Linq webhook timestamp is too old or invalid", { status: 401 }),
    };
  }

  if (!signingSecret) {
    return {
      ok: false,
      response: new Response("Linq webhook signing secret is not configured", { status: 503 }),
    };
  }

  if (!(await verifyLinqSignature(timestamp, signature, signingSecret, rawBody))) {
    return {
      ok: false,
      response: new Response("Invalid Linq webhook signature", { status: 401 }),
    };
  }

  return { ok: true, rawBody };
}

function isFreshTimestamp(timestamp: string): boolean {
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
