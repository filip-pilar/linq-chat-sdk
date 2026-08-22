import { createHmac } from "node:crypto";

import type { StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/index.js";
import deliveredFixture from "./fixtures/message-delivered-2026-02-03.json";
import fixture from "./fixtures/message-received-2026-02-03.json";

const SIGNING_KEY_A = "convergence-signing-key-a";
const SIGNING_KEY_B = "convergence-signing-key-b";
const SIGNING_SECRET_A = `whsec_${Buffer.from(SIGNING_KEY_A).toString("base64")}`;
const SIGNING_SECRET_B = `whsec_${Buffer.from(SIGNING_KEY_B).toString("base64")}`;

describe("credential convergence", () => {
  it("rejects structurally permitted but unusable configurations at construction", () => {
    const credentials = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(() => createLinqAdapter({})).toThrow("requires apiKey or a credentials provider");
    expect(() => createLinqAdapter({ apiKey: "static-key" })).toThrow(
      "requires signingSecret, credentials, or a trusted webhookVerifier",
    );
    expect(() => createLinqAdapter({ apiKey: "static-key", signingSecret: undefined })).toThrow(
      "requires signingSecret, credentials, or a trusted webhookVerifier",
    );
    expect(() => createLinqAdapter({ apiKey: "static-key", signingSecret: "" })).toThrow(
      "requires signingSecret, credentials, or a trusted webhookVerifier",
    );
    expect(() => createLinqAdapter({ apiKey: "static-key", signingSecret: "   " })).toThrow(
      "requires a valid Standard Webhooks signing secret",
    );
    expect(() =>
      createLinqAdapter({ apiKey: "static-key", signingSecret: "whsec_not-base64!" }),
    ).toThrow("requires a valid Standard Webhooks signing secret");
    expect(() =>
      createLinqAdapter({ apiKey: "static-key", signingSecret: ` ${SIGNING_SECRET_A}` }),
    ).toThrow("requires a valid Standard Webhooks signing secret");
    expect(() =>
      createLinqAdapter({ apiKey: "static-key", signingSecret: "dGVzdC1zZWNyZXQ=" }),
    ).not.toThrow();
    expect(() => createLinqAdapter({ credentials })).not.toThrow();
    expect(() =>
      createLinqAdapter({ apiKey: "static-key", webhookVerifier: () => true }),
    ).not.toThrow();
    expect(credentials).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("applies direct, lazy, and forwarded authentication authority precedence exactly", async () => {
    const credentials = vi.fn().mockResolvedValue({
      apiKey: "lazy-key",
      signingSecret: SIGNING_SECRET_B,
    });
    expect(() =>
      createLinqAdapter({
        apiKey: "static-key",
        credentials,
        signingSecret: "malformed-static-secret",
      }),
    ).toThrow("valid Standard Webhooks signing secret");
    expect(credentials).not.toHaveBeenCalled();

    const forwarded = createLinqAdapter({
      apiKey: "static-key",
      signingSecret: "ignored-malformed-secret",
      webhookVerifier: () => true,
    });
    await expect(forwarded.verifyWebhook(unsigned(fixture))).resolves.toMatchObject({ ok: true });

    const lazy = createLinqAdapter({ apiKey: "static-key", credentials, signingSecret: "" });
    await expect(lazy.verifyWebhook(signed(fixture, SIGNING_KEY_B))).resolves.toMatchObject({
      ok: true,
    });
    expect(credentials).toHaveBeenCalledOnce();

    const malformedLazy = createLinqAdapter({
      credentials: vi.fn().mockResolvedValue({
        apiKey: "lazy-key",
        signingSecret: "not-a-standard-webhook-secret",
      }),
    });
    await expect(malformedLazy.verifyWebhook(unsigned(fixture))).resolves.toMatchObject({
      ok: false,
      error: { code: "missing_signature_headers", status: 401 },
    });
    await expect(
      malformedLazy.verifyWebhook(signed(fixture, SIGNING_KEY_A)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_signing_secret", status: 503 },
    });
  });

  it("keeps synchronous client access for static credentials", async () => {
    const adapter = createLinqAdapter({ apiKey: "static-key", signingSecret: SIGNING_SECRET_A });

    expect(adapter.client).toBe(await adapter.getClient());
    expect(adapter.client.apiKey).toBe("static-key");
  });

  it("resolves lazy native clients with current rotating credentials", async () => {
    const credentials = vi
      .fn()
      .mockResolvedValueOnce({ apiKey: "rotating-key-a", signingSecret: SIGNING_SECRET_A })
      .mockResolvedValueOnce({ apiKey: "rotating-key-b", signingSecret: SIGNING_SECRET_B });
    const adapter = createLinqAdapter({ credentials });

    expect(() => adapter.client).toThrow("await adapter.getClient()");
    expect((await adapter.getClient()).apiKey).toBe("rotating-key-a");
    expect((await adapter.getClient()).apiKey).toBe("rotating-key-b");
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  it("uses the current lazy signing secret for every direct webhook", async () => {
    const credentials = vi
      .fn()
      .mockResolvedValueOnce({ apiKey: "key-a", signingSecret: SIGNING_SECRET_A })
      .mockResolvedValueOnce({ apiKey: "key-b", signingSecret: SIGNING_SECRET_B });
    const adapter = createLinqAdapter({ credentials });

    await expect(adapter.verifyWebhook(signed(fixture, SIGNING_KEY_A))).resolves.toMatchObject({
      ok: true,
    });
    await expect(adapter.verifyWebhook(signed(fixture, SIGNING_KEY_B))).resolves.toMatchObject({
      ok: true,
    });
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  it("uses a fresh lazy credential for each adapter-owned provider operation", async () => {
    const credentials = vi
      .fn()
      .mockResolvedValueOnce({ apiKey: "operation-key-a" })
      .mockResolvedValueOnce({ apiKey: "operation-key-b" });
    const authorizations: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      authorizations.push(request.headers.get("authorization") ?? "");
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const adapter = createLinqAdapter({
      baseURL: "https://provider.example.test/api/partner",
      credentials,
      webhookVerifier: () => true,
    });

    try {
      await adapter.startTyping("linq:11111111-1111-4111-8111-111111111111");
      await adapter.startTyping("linq:11111111-1111-4111-8111-111111111111");
    } finally {
      fetchSpy.mockRestore();
    }

    expect(authorizations).toEqual(["Bearer operation-key-a", "Bearer operation-key-b"]);
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  it("surfaces failed lazy resolution without provider I/O", async () => {
    const credentials = vi.fn().mockRejectedValue(new Error("credential store unavailable"));
    const adapter = createLinqAdapter({ credentials });

    await expect(adapter.getClient()).rejects.toThrow("credential store unavailable");
    await expect(adapter.verifyWebhook(unsigned(fixture))).resolves.toMatchObject({
      ok: false,
      error: { code: "missing_signing_secret", status: 503 },
    });
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  it("validates locally knowable input before resolving lazy credentials", async () => {
    const credentials = vi.fn().mockResolvedValue({ apiKey: "unused" });
    const adapter = createLinqAdapter({ credentials, webhookVerifier: () => true });

    await expect(adapter.startTyping("linq:not-a-uuid")).rejects.toThrow("valid chat UUID");
    await expect(adapter.postMessage("linq:chat-id", "x".repeat(10_001))).rejects.toThrow("10000");
    expect(credentials).not.toHaveBeenCalled();
  });

  it("uses one lazy credential snapshot for the released markRead compatibility alias", async () => {
    const credentials = vi.fn().mockResolvedValue({ apiKey: "mark-read-key" });
    const requests: Request[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const adapter = createLinqAdapter({
      baseURL: "https://provider.example.test/api/partner",
      credentials,
      webhookVerifier: () => true,
    });

    await adapter.markRead("linq:11111111-1111-4111-8111-111111111111", "message-id");

    expect(credentials).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer mark-read-key");
    expect(requests[0]?.url).toContain("/v3/chats/11111111-1111-4111-8111-111111111111/read");
    fetchSpy.mockRestore();
  });

  it("rejects an invalid compatibility mark-read ID before lazy credentials or provider I/O", async () => {
    const credentials = vi.fn().mockResolvedValue({ apiKey: "unused" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = createLinqAdapter({ credentials, webhookVerifier: () => true });

    await expect(adapter.markRead("foreign:chat", "message-id")).rejects.toThrow(
      "Invalid Linq thread ID",
    );
    expect(credentials).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("trusted forwarding convergence", () => {
  it("authenticates the exact raw body once without direct-signature fallback", async () => {
    const rawBody = `${JSON.stringify(fixture)}\n`;
    const verifier = vi.fn((_request: Request, bytes: Uint8Array) => {
      expect(Buffer.from(bytes).toString("utf8")).toBe(rawBody);
      return true;
    });
    const adapter = createLinqAdapter({ apiKey: "static-key", webhookVerifier: verifier });
    const request = new Request("https://forwarder.example.test/linq", {
      method: "POST",
      body: rawBody,
    });
    const arrayBuffer = vi.spyOn(request, "arrayBuffer");

    const result = await adapter.verifyWebhook(request);

    expect(result).toMatchObject({
      ok: true,
      webhook: {
        transport: { scheme: "trusted_forwarder", webhookId: null, timestamp: "" },
        rawBody,
      },
    });
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it("isolates retained webhook bytes from a mutating trusted verifier", async () => {
    const rawBody = `${JSON.stringify(fixture)}\n`;
    const originalBase64 = Buffer.from(rawBody).toString("base64");
    const verifier = vi.fn((_request: Request, bytes: Uint8Array) => {
      bytes.fill(0x78);
      return true;
    });
    const adapter = createLinqAdapter({ apiKey: "static-key", webhookVerifier: verifier });
    const observed = vi.fn();
    const setIfNotExists = vi.fn().mockResolvedValue(true);
    adapter.onLinqEvent(observed);
    (adapter as unknown as { state: StateAdapter }).state = {
      setIfNotExists,
    } as unknown as StateAdapter;
    const request = new Request("https://forwarder.example.test/linq", {
      method: "POST",
      body: rawBody,
    });

    const result = await adapter.verifyWebhook(request);
    expect(result).toMatchObject({
      ok: true,
      webhook: { rawBody, rawBodyBase64: originalBase64, rawEvent: fixture },
    });
    if (!result.ok) throw new Error("Expected trusted verification success");

    await expect(adapter.dispatchVerifiedWebhook(result.webhook)).resolves.toEqual({
      handled: "ignored",
    });
    expect(observed).toHaveBeenCalledWith(
      expect.objectContaining({ rawEvent: fixture, data: fixture.data }),
    );
    expect(result.webhook.envelope.eventId).toBe(fixture.event_id);
    expect(setIfNotExists).toHaveBeenCalledWith(
      `dedupe:linq:event:${fixture.partner_id}:${fixture.event_id}`,
      true,
      60 * 60 * 1000,
    );
  });

  it("does not fall back to a valid direct signature when the forwarder rejects", async () => {
    const verifier = vi.fn().mockReturnValue(false);
    const adapter = createLinqAdapter({
      apiKey: "static-key",
      signingSecret: SIGNING_SECRET_A,
      webhookVerifier: verifier,
    });

    await expect(adapter.verifyWebhook(signed(fixture, SIGNING_KEY_A))).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_signature", status: 401 },
    });
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it("rejects a throwing forwarder and never resolves signing credentials", async () => {
    const credentials = vi.fn().mockResolvedValue({
      apiKey: "unused",
      signingSecret: SIGNING_SECRET_A,
    });
    const adapter = createLinqAdapter({
      credentials,
      webhookVerifier: () => {
        throw new Error("untrusted");
      },
    });

    await expect(adapter.verifyWebhook(unsigned(fixture))).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_signature", status: 401 },
    });
    expect(credentials).not.toHaveBeenCalled();
  });

  it("shares fast acknowledgement, atomic dedupe, and waitUntil with trusted delivery", async () => {
    const adapter = createLinqAdapter({
      apiKey: "static-key",
      webhookVerifier: () => true,
    });
    const setIfNotExists = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    (adapter as unknown as { state: StateAdapter }).state = {
      setIfNotExists,
    } as unknown as StateAdapter;
    (adapter as unknown as { chat: { processMessage: ReturnType<typeof vi.fn> } }).chat = {
      processMessage: vi.fn(),
    };
    let release: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(() => completion);
    adapter.onLinqEvent("message.received", handler);
    const tasks: Promise<unknown>[] = [];
    const options = { waitUntil: (task: Promise<unknown>) => tasks.push(task) };

    const first = await adapter.handleWebhook(unsigned(fixture), options);

    expect(first.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(1);
    release?.();
    await Promise.all(tasks);

    const duplicate = await adapter.handleWebhook(unsigned(fixture), options);
    expect(duplicate.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(setIfNotExists).toHaveBeenCalledTimes(2);
  });

  it("keeps trusted malformed curated timestamps generic-only and lossless", async () => {
    const adapter = createLinqAdapter({ apiKey: "static-key", webhookVerifier: () => true });
    const named = vi.fn();
    const generic = vi.fn();
    const delivery = vi.fn();
    const tasks: Promise<unknown>[] = [];
    const payload = {
      ...deliveredFixture,
      event_id: "trusted-invalid-delivered-timestamp",
      data: { ...deliveredFixture.data, delivered_at: "2026-02-30T00:00:00Z" },
    };
    (adapter as unknown as { state: StateAdapter }).state = {
      setIfNotExists: vi.fn().mockResolvedValue(true),
    } as unknown as StateAdapter;
    adapter.onLinqEvent("message.delivered", named);
    adapter.onLinqEvent(generic);
    adapter.onDeliveryStatus(delivery);

    const response = await adapter.handleWebhook(unsigned(payload), {
      waitUntil: (task) => tasks.push(task),
    });
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(named).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(generic).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message.delivered", rawEvent: payload }),
    );
  });
});

function unsigned(payload: unknown): Request {
  return new Request("https://example.com/webhooks/linq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function signed(payload: unknown, key: string): Request {
  const body = JSON.stringify(payload);
  const webhookId = `webhook-${key}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", key)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest("base64");

  return new Request("https://example.com/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    body,
  });
}
