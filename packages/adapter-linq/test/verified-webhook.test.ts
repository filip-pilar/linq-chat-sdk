import { createHmac } from "node:crypto";
import type { ChatInstance } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/index.js";
import fixture from "./fixtures/message-received-2026-02-03.json";

const SIGNING_KEY = "test_linq_webhook_secret";
const SIGNING_SECRET = `whsec_${Buffer.from(SIGNING_KEY).toString("base64")}`;

describe("LinqAdapter verified webhook ingress", () => {
  it("reads, verifies, and parses a Standard Webhook exactly once", async () => {
    const adapter = createTestAdapter();
    const request = createStandardRequest(fixture);
    const text = vi.spyOn(request, "text");
    const arrayBuffer = vi.spyOn(request, "arrayBuffer");
    const unwrap = vi.spyOn(adapter.client.webhooks, "unwrap");

    const result = await adapter.verifyWebhook(request);

    expect(result.ok).toBe(true);
    expect(text).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(unwrap).toHaveBeenCalledTimes(1);
    expect(request.bodyUsed).toBe(true);
  });

  it("reads and verifies a legacy webhook exactly once", async () => {
    const adapter = createTestAdapter();
    const request = createLegacyRequest(fixture, {
      "x-webhook-event": "message.received",
      "x-webhook-subscription-id": "subscription-123",
    });
    const text = vi.spyOn(request, "text");
    const arrayBuffer = vi.spyOn(request, "arrayBuffer");
    const unwrap = vi.spyOn(adapter.client.webhooks, "unwrap");
    const sign = vi.spyOn(globalThis.crypto.subtle, "sign");

    const result = await adapter.verifyWebhook(request);

    expect(result.ok).toBe(true);
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(unwrap).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.webhook.transport).toEqual({
        scheme: "legacy",
        webhookId: null,
        timestamp: expect.any(String),
        subscriptionId: "subscription-123",
        eventType: "message.received",
      });
    }
  });

  it("accepts complete dual headers through the valid legacy signature", async () => {
    const adapter = createTestAdapter();
    const dual = createLegacyRequest(fixture, {
      "webhook-id": "dual-header-event",
      "webhook-signature": "v1,invalid-for-legacy-subscription-secret",
      "webhook-timestamp": Math.floor(Date.now() / 1000).toString(),
      "x-webhook-event": "message.received",
      "x-webhook-subscription-id": "subscription-123",
    });

    const result = await adapter.verifyWebhook(dual);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.webhook.transport).toMatchObject({
        scheme: "legacy",
        webhookId: "dual-header-event",
        subscriptionId: "subscription-123",
      });
    }
  });

  it("resists downgrade from partial Standard headers to a valid legacy signature", async () => {
    const adapter = createTestAdapter();
    const legacy = createLegacyRequest(fixture, { "webhook-id": "partial-standard" });

    const result = await adapter.verifyWebhook(legacy);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_signature",
        status: 401,
        message: "Invalid Linq webhook signature",
      },
    });
  });

  it("returns typed failures for authentication, JSON, payload, and version errors", async () => {
    const adapter = createTestAdapter();
    const cases: Array<[Request, string, number]> = [
      [
        new Request("https://example.com", { method: "POST", body: "{}" }),
        "missing_signature_headers",
        401,
      ],
      [createLegacyRequest(fixture, { "x-webhook-timestamp": "0" }), "stale_timestamp", 401],
      [createStandardRequest(fixture, { signature: "v1,invalid" }), "invalid_signature", 401],
      [createSignedBody("{"), "invalid_json", 400],
      [
        createStandardRequest({ ...fixture, data: { ...fixture.data, parts: "bad" } }),
        "invalid_payload",
        400,
      ],
      [createStandardRequest({ ...fixture, api_version: "v2" }), "invalid_payload", 400],
      [
        createStandardRequest({ ...fixture, webhook_version: "2025-01-01" }),
        "unsupported_version",
        400,
      ],
    ];

    for (const [request, code, status] of cases) {
      const result = await adapter.verifyWebhook(request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.status).toBe(status);
      }
    }

    const missingSecret = createLinqAdapter({ apiKey: "test_linq_api_key", signingSecret: "" });
    await expect(
      missingSecret.verifyWebhook(createStandardRequest(fixture)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "missing_signing_secret", status: 503 },
    });
  });

  it("returns 400 from the one-step path for a malformed signed current payload", async () => {
    const response = await createTestAdapter().handleWebhook(
      createStandardRequest({ ...fixture, data: { ...fixture.data, parts: "bad" } }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid Linq webhook payload");
  });

  it("exposes current envelope, transport, endpoint, message, attachment, and reply facts", async () => {
    const adapter = createTestAdapter();
    const request = createStandardRequest(fixture, {
      "x-webhook-event": "message.received",
      "x-webhook-subscription-id": "subscription-123",
    });

    const result = await adapter.verifyWebhook(request);

    expect(result.ok).toBe(true);
    if (!result.ok || result.webhook.kind !== "message.received") {
      throw new Error("Expected a verified message webhook");
    }

    expect(result.webhook.envelope).toEqual({
      provider: "linq",
      apiVersion: "v3",
      webhookVersion: "2026-02-03",
      eventType: "message.received",
      eventId: fixture.event_id,
      createdAt: fixture.created_at,
      traceId: fixture.trace_id,
      partnerId: fixture.partner_id,
    });
    expect(result.webhook.transport).toEqual({
      scheme: "standard",
      webhookId: "webhook-test-id",
      timestamp: expect.any(String),
      subscriptionId: "subscription-123",
      eventType: "message.received",
    });
    expect(result.webhook.message).toMatchObject({
      providerMessageId: fixture.data.id,
      chatId: fixture.data.chat.id,
      conversationKind: "direct",
      direction: "inbound",
      service: "iMessage",
      receivingEndpoint: { kind: "email", value: "owner@example.com" },
      remoteEndpoint: { kind: "phone", value: "+15550002000" },
      ownerHandle: {
        id: fixture.data.chat.owner_handle.id,
        handle: "owner@example.com",
        service: "iMessage",
        endpoint: { kind: "email", value: "owner@example.com" },
      },
      senderHandle: {
        id: fixture.data.sender_handle.id,
        handle: "+15550002000",
        service: "iMessage",
        endpoint: { kind: "phone", value: "+15550002000" },
      },
      timestamps: {
        sentAt: fixture.data.sent_at,
        deliveredAt: fixture.data.delivered_at,
        readAt: null,
        reconciledAt: fixture.data.reconciled_at,
      },
      replyContext: {
        messageId: fixture.data.reply_to.message_id,
        partIndex: 1,
      },
    });
    expect(result.webhook.message.parts).toHaveLength(2);
    expect(result.webhook.message.attachments).toEqual([
      {
        id: fixture.data.parts[1]?.id,
        filename: "photo.png",
        mimeType: "image/png",
        sizeBytes: 4321,
        url: "https://uploads.example.com/photo.png",
        width: 640,
        height: 480,
      },
    ]);
  });

  it.each([
    [false, "direct"],
    [true, "group"],
    [null, "unknown"],
  ] as const)("maps is_group=%s to %s", async (isGroup, expected) => {
    const payload = cloneFixture();
    payload.data.chat.is_group = isGroup;
    const result = await createTestAdapter().verifyWebhook(createStandardRequest(payload));

    expect(result.ok).toBe(true);
    if (result.ok && result.webhook.kind === "message.received") {
      expect(result.webhook.message.conversationKind).toBe(expected);
    }
  });

  it("keeps nullable and unknown endpoint observations explicit", async () => {
    const payload = cloneFixture();
    payload.data.chat.owner_handle = null;
    payload.data.sender_handle.handle = "+0123";
    const result = await createTestAdapter().verifyWebhook(createStandardRequest(payload));

    expect(result.ok).toBe(true);
    if (result.ok && result.webhook.kind === "message.received") {
      expect(result.webhook.message.ownerHandle).toBeNull();
      expect(result.webhook.message.receivingEndpoint).toBeNull();
      expect(result.webhook.message.remoteEndpoint).toEqual({ kind: "unknown", value: "+0123" });
    }
  });

  it("does not claim the sender is a remote endpoint for an outbound observation", async () => {
    const payload = cloneFixture();
    payload.data.direction = "outbound";
    const result = await createTestAdapter().verifyWebhook(createStandardRequest(payload));

    expect(result.ok).toBe(true);
    if (result.ok && result.webhook.kind === "message.received") {
      expect(result.webhook.message.direction).toBe("outbound");
      expect(result.webhook.message.remoteEndpoint).toBeNull();
    }
  });

  it.each(["iMessage", "SMS", "RCS"] as const)(
    "preserves %s service observations",
    async (service) => {
      const payload = cloneFixture();
      payload.data.service = service;
      payload.data.sender_handle.service = service;
      if (payload.data.chat.owner_handle) {
        payload.data.chat.owner_handle.service = service;
      }

      const result = await createTestAdapter().verifyWebhook(createStandardRequest(payload));

      expect(result.ok).toBe(true);
      if (result.ok && result.webhook.kind === "message.received") {
        expect(result.webhook.message.service).toBe(service);
        expect(result.webhook.message.senderHandle.service).toBe(service);
        expect(result.webhook.message.ownerHandle?.service).toBe(service);
      }
    },
  );

  it("preserves the complete authenticated raw envelope", async () => {
    const result = await createTestAdapter().verifyWebhook(createStandardRequest(fixture));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.webhook.rawEvent).toEqual(fixture);
      expect(Object.isFrozen(result.webhook.rawEvent)).toBe(true);
      expect(Object.isFrozen(result.webhook.rawEvent.data)).toBe(true);
    }
  });

  it("keeps public raw mutations out of dispatch and forwards WebhookOptions", async () => {
    const adapter = createTestAdapter();
    const processMessage = vi.fn((..._args: Parameters<ChatInstance["processMessage"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
      processMessage,
    };
    const waitUntil = vi.fn((_task: Promise<unknown>) => {});
    const options = { waitUntil };

    const verification = await adapter.verifyWebhook(createStandardRequest(fixture));
    expect(processMessage).not.toHaveBeenCalled();
    if (!verification.ok) {
      throw new Error("Expected verification success");
    }

    const publicData = verification.webhook.rawEvent.data as Record<string, unknown>;
    const publicParts = publicData.parts as readonly Record<string, unknown>[];
    expect(Reflect.set(publicData, "id", "mutated-message-id")).toBe(false);
    expect(Reflect.set(publicParts[0] ?? {}, "value", "mutated text")).toBe(false);

    const dispatch = await adapter.dispatchVerifiedWebhook(verification.webhook, options);

    expect(dispatch).toEqual({ handled: "message" });
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledWith(
      adapter,
      `linq:${fixture.data.chat.id}`,
      expect.any(Function),
      options,
    );
    const messageFactory = processMessage.mock.calls[0]?.[2];
    const message = await messageFactory?.();
    expect(message?.raw).toEqual(fixture.data);
    expect(message?.raw).not.toBe(verification.webhook.rawEvent.data);
    expect(message?.id).toBe(fixture.data.id);
    expect(message?.text).toContain("See attachment");
    expect(message?.raw).not.toEqual(fixture);
  });

  it("keeps normal-path Message.raw mutable and message-shaped", async () => {
    const adapter = createTestAdapter();
    const processMessage = vi.fn((..._args: Parameters<ChatInstance["processMessage"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
      processMessage,
    };

    const response = await adapter.handleWebhook(createStandardRequest(fixture));
    const messageFactory = processMessage.mock.calls[0]?.[2];
    const message = await messageFactory?.();
    const raw = message?.raw as { id: string };

    expect(response.status).toBe(200);
    expect(raw).toEqual(fixture.data);
    expect(raw).not.toEqual(fixture);
    expect(Object.isFrozen(raw)).toBe(false);
    raw.id = "consumer-local-mutation";
    expect(raw.id).toBe("consumer-local-mutation");
  });

  it("rejects forged results and results produced by another adapter", async () => {
    const first = createTestAdapter();
    const second = createTestAdapter();
    const result = await first.verifyWebhook(createStandardRequest(fixture));

    expect(result.ok).toBe(true);
    await expect(first.dispatchVerifiedWebhook({} as never)).rejects.toThrow(TypeError);
    if (result.ok) {
      await expect(second.dispatchVerifiedWebhook(result.webhook)).rejects.toThrow(
        "produced by this adapter",
      );
    }
  });

  it("reports unsupported versions in the typed API while preserving handleWebhook compatibility", async () => {
    const payload = { ...fixture, webhook_version: "2025-01-01" };
    const adapter = createTestAdapter();
    const processMessage = vi.fn((..._args: Parameters<ChatInstance["processMessage"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
      processMessage,
    };

    const verification = await adapter.verifyWebhook(createStandardRequest(payload));
    const response = await adapter.handleWebhook(createStandardRequest(payload));

    expect(verification).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("verifies reactions and current unhandled events without forcing dispatch", async () => {
    const reaction = cloneFixture() as Record<string, unknown>;
    reaction.event_type = "reaction.added";
    reaction.data = {
      is_from_me: false,
      reaction_type: "like",
      chat_id: fixture.data.chat.id,
      message_id: fixture.data.id,
      part_index: 1,
      custom_emoji: null,
      reacted_at: "2026-05-08T16:22:00.000Z",
      service: "iMessage",
      from_handle: fixture.data.sender_handle,
    };
    const unhandled = { ...fixture, event_type: "message.delivered" };
    const adapter = createTestAdapter();
    const processReaction = vi.fn((..._args: Parameters<ChatInstance["processReaction"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processReaction"> }).chat = {
      processReaction,
    };

    const reactionResult = await adapter.verifyWebhook(createStandardRequest(reaction));
    const unhandledResult = await adapter.verifyWebhook(createStandardRequest(unhandled));

    expect(reactionResult).toMatchObject({
      ok: true,
      webhook: {
        kind: "reaction.added",
        reaction: {
          chatId: fixture.data.chat.id,
          providerMessageId: fixture.data.id,
          partIndex: 1,
          reactionType: "like",
          customEmoji: null,
          reactedAt: "2026-05-08T16:22:00.000Z",
          service: "iMessage",
          isFromMe: false,
          senderHandle: { id: fixture.data.sender_handle.id },
          remoteEndpoint: { kind: "phone", value: "+15550002000" },
        },
      },
    });
    expect(unhandledResult).toMatchObject({ ok: true, webhook: { kind: "unhandled" } });
    if (reactionResult.ok) {
      await expect(adapter.dispatchVerifiedWebhook(reactionResult.webhook)).resolves.toEqual({
        handled: "reaction",
      });
      expect(processReaction).toHaveBeenCalledTimes(1);
    }
    if (unhandledResult.ok) {
      await expect(adapter.dispatchVerifiedWebhook(unhandledResult.webhook)).resolves.toEqual({
        handled: "ignored",
      });
    }
  });
});

function createTestAdapter() {
  return createLinqAdapter({ apiKey: "test_linq_api_key", signingSecret: SIGNING_SECRET });
}

type MutableFixture = Record<string, unknown> & {
  event_type: string;
  webhook_version: string;
  data: Record<string, unknown> & {
    chat: Record<string, unknown> & {
      is_group: boolean | null;
      owner_handle: Record<string, unknown> | null;
    };
    sender_handle: Record<string, unknown> & { handle: string };
  };
};

function cloneFixture(): MutableFixture {
  return structuredClone(fixture) as unknown as MutableFixture;
}

function createStandardRequest(
  payload: unknown,
  overrides: Record<string, string> & { signature?: string } = {},
): Request {
  return createSignedBody(JSON.stringify(payload), overrides);
}

function createSignedBody(
  body: string,
  overrides: Record<string, string> & { signature?: string } = {},
): Request {
  const timestamp = overrides["webhook-timestamp"] ?? Math.floor(Date.now() / 1000).toString();
  const webhookId = overrides["webhook-id"] ?? "webhook-test-id";
  const signature =
    overrides.signature ??
    `v1,${createHmac("sha256", SIGNING_KEY)
      .update(`${webhookId}.${timestamp}.${body}`)
      .digest("base64")}`;
  const headers = new Headers({
    "content-type": "application/json",
    "webhook-id": webhookId,
    "webhook-signature": signature,
    "webhook-timestamp": timestamp,
  });

  for (const [name, value] of Object.entries(overrides)) {
    if (name !== "signature") {
      headers.set(name, value);
    }
  }

  return new Request("https://example.com/webhooks/linq", { method: "POST", headers, body });
}

function createLegacyRequest(payload: unknown, extraHeaders: Record<string, string> = {}): Request {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", SIGNING_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  return new Request("https://example.com/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": signature,
      "x-webhook-timestamp": timestamp,
      ...extraHeaders,
    },
    body,
  });
}
