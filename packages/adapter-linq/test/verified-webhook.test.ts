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

    const result = await adapter.verifyWebhook(request);

    expect(result.ok).toBe(true);
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(request.bodyUsed).toBe(true);
  });

  it("rejects deliveries without complete Standard Webhook headers", async () => {
    await expect(
      createTestAdapter().verifyWebhook(
        new Request("https://example.com", {
          method: "POST",
          headers: { "x-webhook-signature": "deprecated" },
          body: JSON.stringify(fixture),
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "missing_signature_headers", status: 401 },
    });

    const partial = createStandardRequest(fixture);
    const headers = new Headers(partial.headers);
    headers.delete("webhook-signature");
    await expect(
      createTestAdapter().verifyWebhook(
        new Request(partial.url, { method: "POST", headers, body: await partial.text() }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "missing_signature_headers",
        status: 401,
        message: "Incomplete Standard Webhook headers",
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
      [createStandardRequest(fixture, { "webhook-timestamp": "0" }), "stale_timestamp", 401],
      [createStandardRequest(fixture, { signature: "v1,invalid" }), "invalid_signature", 401],
      [createSignedBody("{"), "invalid_json", 400],
      [
        createStandardRequest({ ...fixture, data: { ...fixture.data, parts: "bad" } }),
        "invalid_payload",
        400,
      ],
      [createStandardRequest({ ...fixture, api_version: "v2" }), "invalid_payload", 400],
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

  it("enforces Standard Webhook timestamp boundaries", async () => {
    const now = Math.floor(Date.now() / 1000);

    await expect(
      createTestAdapter().verifyWebhook(
        createStandardRequest(fixture, { "webhook-timestamp": String(now - 300) }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      createTestAdapter().verifyWebhook(
        createStandardRequest(fixture, { "webhook-timestamp": String(now - 301) }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "stale_timestamp" } });
  });

  it("rejects tampering, wrong secrets, and substituted Standard webhook IDs", async () => {
    const signed = createStandardRequest(fixture);
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify({ ...fixture, event_id: "tampered" }),
    });
    const substitutedHeaders = new Headers(createStandardRequest(fixture).headers);
    substitutedHeaders.set("webhook-id", "substituted-id");
    const substituted = new Request("https://example.com/webhooks/linq", {
      method: "POST",
      headers: substitutedHeaders,
      body: JSON.stringify(fixture),
    });
    const wrongSecret = createLinqAdapter({
      apiKey: "test_linq_api_key",
      signingSecret: `whsec_${Buffer.from("wrong-key").toString("base64")}`,
    });

    for (const [adapter, request] of [
      [createTestAdapter(), tampered],
      [createTestAdapter(), substituted],
      [wrongSecret, createStandardRequest(fixture)],
    ] as const) {
      await expect(adapter.verifyWebhook(request)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_signature", status: 401 },
      });
    }
  });

  it("accepts any valid v1 signature in a multiple-signature Standard header", async () => {
    const valid = createStandardRequest(fixture);
    const signature = valid.headers.get("webhook-signature");

    await expect(
      createTestAdapter().verifyWebhook(
        createStandardRequest(fixture, { signature: `v1,invalid ${signature}` }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("reports invalid Standard secrets as configuration failures", async () => {
    const invalidSecret = createLinqAdapter({
      apiKey: "test_linq_api_key",
      signingSecret: "whsec_not-valid-base64!",
    });

    await expect(
      invalidSecret.verifyWebhook(createStandardRequest(fixture)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_signing_secret", status: 503 },
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
    const request = createStandardRequest(fixture);

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
      versionStatus: "current",
    });
    expect(result.webhook.transport).toEqual({
      scheme: "standard",
      webhookId: "webhook-test-id",
      timestamp: expect.any(String),
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
        reconciledAt: null,
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

  it("preserves typed effect, service, decoration, reaction, sticker, and raw part facts", async () => {
    const payload = cloneFixture();
    payload.data.preferred_service = "iMessage";
    payload.data.effect = { type: "bubble", name: "slam" };
    payload.data.parts = [
      {
        type: "text",
        value: "styled",
        text_decorations: [
          { range: [0, 6], style: "bold" },
          { range: [1, 3], animation: "shake" },
        ],
        reactions: [
          {
            type: "sticker",
            is_me: false,
            handle: fixture.data.sender_handle,
            sticker: {
              file_name: "cat.heic",
              mime_type: "image/heic",
              url: "https://cdn.linqapp.com/sticker/cat",
              width: 120,
              height: 100,
            },
          },
        ],
      },
      null,
      { unexpected: true },
      { type: "future_part", payload: { retained: true } },
    ];

    const result = await createTestAdapter().verifyWebhook(createStandardRequest(payload));

    expect(result.ok).toBe(true);
    if (!result.ok || result.webhook.kind !== "message.received") {
      throw new Error("Expected a verified message webhook");
    }
    expect(result.webhook.message).toMatchObject({
      preferredService: "iMessage",
      effect: { type: "bubble", name: "slam" },
      partObservations: [
        {
          index: 0,
          type: "text",
          value: "styled",
          textDecorations: [
            { range: [0, 6], style: "bold", animation: null },
            { range: [1, 3], style: null, animation: "shake" },
          ],
          reactions: [
            {
              type: "sticker",
              isMe: false,
              sticker: {
                filename: "cat.heic",
                mimeType: "image/heic",
                url: "https://cdn.linqapp.com/sticker/cat",
                width: 120,
                height: 100,
              },
            },
          ],
        },
        { index: 1, type: null, raw: null },
        { index: 2, type: null, raw: { unexpected: true } },
        { index: 3, type: "future_part", raw: { type: "future_part" } },
      ],
    });
    expect(result.webhook.rawEvent.data).toMatchObject({ parts: payload.data.parts });
    expect(Object.isFrozen(result.webhook.message.partObservations)).toBe(true);
    expect(Object.isFrozen(result.webhook.message.partObservations[0]?.raw)).toBe(true);
  });

  it("dispatches an unexpected null-parts current webhook as an empty usable message", async () => {
    const payload = cloneFixture();
    payload.data.parts = null;
    const adapter = createTestAdapter();
    const dispatched: unknown[] = [];
    const processMessage = vi.fn(async (...args: Parameters<ChatInstance["processMessage"]>) => {
      const messageOrFactory = args[2];
      dispatched.push(
        typeof messageOrFactory === "function" ? await messageOrFactory() : messageOrFactory,
      );
    });
    (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
      processMessage,
    };

    const response = await adapter.handleWebhook(createStandardRequest(payload));

    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([
      expect.objectContaining({ id: fixture.data.id, text: "", attachments: [] }),
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
      expect(result.webhook.rawBody).toBe(JSON.stringify(fixture));
      expect(Buffer.from(result.webhook.rawBodyBase64, "base64").toString("utf8")).toBe(
        JSON.stringify(fixture),
      );
    }
  });

  it("keeps public raw mutations out of dispatch and forwards WebhookOptions", async () => {
    const adapter = createTestAdapter();
    const processMessage = vi.fn(
      async (..._args: Parameters<ChatInstance["processMessage"]>) => {},
    );
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
    const messageOrFactory = processMessage.mock.calls[0]?.[2];
    const message =
      typeof messageOrFactory === "function" ? await messageOrFactory() : messageOrFactory;
    expect(message?.raw).toEqual(fixture.data);
    expect(message?.raw).not.toBe(verification.webhook.rawEvent.data);
    expect(message?.id).toBe(fixture.data.id);
    expect(message?.text).toContain("See attachment");
    expect(message?.raw).not.toEqual(fixture);
  });

  it("keeps normal-path Message.raw mutable and message-shaped", async () => {
    const adapter = createTestAdapter();
    const processMessage = vi.fn(
      async (..._args: Parameters<ChatInstance["processMessage"]>) => {},
    );
    (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
      processMessage,
    };

    const response = await adapter.handleWebhook(createStandardRequest(fixture));
    const messageOrFactory = processMessage.mock.calls[0]?.[2];
    const message =
      typeof messageOrFactory === "function" ? await messageOrFactory() : messageOrFactory;
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

  it("preserves older versions in the typed API and compatibility dispatch", async () => {
    const payload = { ...fixture, webhook_version: "2025-01-01" };
    const adapter = createTestAdapter();
    const processMessage = vi.fn(
      async (..._args: Parameters<ChatInstance["processMessage"]>) => {},
    );
    (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
      processMessage,
    };

    const verification = await adapter.verifyWebhook(createStandardRequest(payload));
    const response = await adapter.handleWebhook(createStandardRequest(payload));

    expect(verification).toMatchObject({
      ok: true,
      webhook: {
        kind: "unsupported_version",
        envelope: { webhookVersion: "2025-01-01", versionStatus: "older" },
      },
    });
    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["2027-01-01", "future"],
    ["preview", "unknown"],
  ] as const)(
    "preserves and ignores %s webhook versions",
    async (webhookVersion, versionStatus) => {
      const payload = {
        ...fixture,
        webhook_version: webhookVersion,
        data: versionStatus === "future" ? ["opaque", { future: true }] : fixture.data,
      };
      const adapter = createTestAdapter();
      const processMessage = vi.fn(
        async (..._args: Parameters<ChatInstance["processMessage"]>) => {},
      );
      (adapter as unknown as { chat: Pick<ChatInstance, "processMessage"> }).chat = {
        processMessage,
      };

      const verification = await adapter.verifyWebhook(createStandardRequest(payload));
      const response = await adapter.handleWebhook(createStandardRequest(payload));

      expect(verification).toMatchObject({
        ok: true,
        webhook: {
          kind: "unsupported_version",
          envelope: { webhookVersion, versionStatus },
          rawEvent: { webhook_version: webhookVersion },
        },
      });
      expect(response.status).toBe(200);
      expect(processMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed version envelopes without losing authenticated future versions", async () => {
    for (const webhookVersion of [null, ""] as const) {
      await expect(
        createTestAdapter().verifyWebhook(
          createStandardRequest({ ...fixture, webhook_version: webhookVersion }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_payload", status: 400 },
      });
    }
  });

  it("verifies reactions and typed lifecycle events without forcing standard dispatch", async () => {
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
    const lifecycle = { ...fixture, event_type: "message.delivered" };
    const adapter = createTestAdapter();
    const processReaction = vi.fn((..._args: Parameters<ChatInstance["processReaction"]>) => {});
    (adapter as unknown as { chat: Pick<ChatInstance, "processReaction"> }).chat = {
      processReaction,
    };

    const reactionResult = await adapter.verifyWebhook(createStandardRequest(reaction));
    const lifecycleResult = await adapter.verifyWebhook(createStandardRequest(lifecycle));

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
    expect(lifecycleResult).toMatchObject({
      ok: true,
      webhook: {
        kind: "message.delivered",
        lifecycle: {
          providerMessageId: fixture.data.id,
          deliveredAt: fixture.data.delivered_at,
          readAt: null,
        },
      },
    });
    if (reactionResult.ok) {
      await expect(adapter.dispatchVerifiedWebhook(reactionResult.webhook)).resolves.toEqual({
        handled: "reaction",
      });
      expect(processReaction).toHaveBeenCalledTimes(1);
    }
    if (lifecycleResult.ok) {
      await expect(adapter.dispatchVerifiedWebhook(lifecycleResult.webhook)).resolves.toEqual({
        handled: "ignored",
      });
    }
  });

  it("keeps sticker reaction webhook metadata typed without inventing a standard emoji", async () => {
    const reaction = cloneFixture() as Record<string, unknown>;
    reaction.event_type = "reaction.added";
    reaction.data = {
      is_from_me: false,
      reaction_type: "sticker",
      chat_id: fixture.data.chat.id,
      message_id: fixture.data.id,
      part_index: 0,
      from_handle: fixture.data.sender_handle,
      sticker: {
        file_name: "cat.heic",
        mime_type: "image/heic",
        url: "https://cdn.linqapp.com/sticker/cat",
        width: 120,
        height: 100,
      },
    };

    const result = await createTestAdapter().verifyWebhook(createStandardRequest(reaction));

    expect(result).toMatchObject({
      ok: true,
      webhook: {
        kind: "reaction.added",
        reaction: {
          reactionType: "sticker",
          partIndex: 0,
          sticker: {
            filename: "cat.heic",
            mimeType: "image/heic",
            url: "https://cdn.linqapp.com/sticker/cat",
            width: 120,
            height: 100,
          },
        },
      },
    });
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
