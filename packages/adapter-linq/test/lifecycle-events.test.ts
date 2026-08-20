import { createHmac } from "node:crypto";

import { Chat } from "chat";
import type { ChatInstance, Logger, StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, type LinqAdapter } from "../src/index.js";
import deliveredFixture from "./fixtures/message-delivered-2026-02-03.json";
import failedFixture from "./fixtures/message-failed-2026-02-03.json";
import readFixture from "./fixtures/message-read-2026-02-03.json";
import sentFixture from "./fixtures/message-sent-2026-02-03.json";

const SIGNING_KEY = "test_linq_webhook_secret";
const SIGNING_SECRET = `whsec_${Buffer.from(SIGNING_KEY).toString("base64")}`;
const EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;
const VOICE_MEMO_ATTACHMENT_ID = "66666666-6666-6666-6666-666666666666";

describe("typed Linq message lifecycle events", () => {
  it.each([
    [sentFixture, "message.sent", null, null],
    [deliveredFixture, "message.delivered", deliveredFixture.data.delivered_at, null],
    [readFixture, "message.read", readFixture.data.delivered_at, readFixture.data.read_at],
  ] as const)(
    "normalizes %s lifecycle correlation",
    async (fixture, eventType, deliveredAt, readAt) => {
      const adapter = createTestAdapter();
      const result = await adapter.verifyWebhook(createStandardRequest(fixture));

      expect(result).toMatchObject({
        ok: true,
        webhook: {
          kind: eventType,
          lifecycle: {
            providerMessageId: fixture.data.id,
            chatId: fixture.data.chat.id,
            direction: "outbound",
            service: "iMessage",
            preferredService: "auto",
            idempotencyKey: "lifecycle-logical-send-1",
            sentAt: fixture.data.sent_at,
            deliveredAt,
            readAt,
            reconciledAt: null,
          },
          envelope: { traceId: fixture.trace_id },
          rawEvent: fixture,
        },
      });
    },
  );

  it("normalizes failure metadata without deriving retry safety", async () => {
    const adapter = createTestAdapter();
    const handler = vi.fn();
    const context = await createContext(adapter);
    adapter.onLinqEvent("message.failed", handler);

    const response = await adapter.handleWebhook(createStandardRequest(failedFixture));

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith({
      type: "message.failed",
      data: {
        providerMessageId: failedFixture.data.message_id,
        chatId: failedFixture.data.chat_id,
        code: 4006,
        detailCode: 100001,
        reason: "Message send timed out",
        service: null,
        preferredService: "RCS",
        failedAt: failedFixture.data.failed_at,
      },
      envelope: expect.objectContaining({ traceId: failedFixture.trace_id }),
      transport: expect.objectContaining({ scheme: "standard" }),
      rawEvent: failedFixture,
    });
    expect(handler.mock.calls[0]?.[0].data).not.toHaveProperty("retryable");
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(context.processReaction).not.toHaveBeenCalled();
  });

  it("accepts unknown numeric failure codes and preserves unknown fields losslessly", async () => {
    const adapter = createTestAdapter();
    const handler = vi.fn();
    await createContext(adapter);
    adapter.onLinqEvent("message.failed", handler);
    const payload = {
      ...failedFixture,
      event_id: "10000000-0000-4000-8000-000000000099",
      data: {
        ...failedFixture.data,
        code: 4999,
        detail_code: 987654,
        future_context: { nested: ["lossless", true] },
      },
    };

    const response = await adapter.handleWebhook(createStandardRequest(payload));

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ code: 4999, detailCode: 987654 }),
        rawEvent: payload,
      }),
    );
    expect(handler.mock.calls[0]?.[0].rawEvent.data).toMatchObject({
      future_context: { nested: ["lossless", true] },
    });
  });

  it.each([
    [sentFixture, { sent_at: null }],
    [deliveredFixture, { delivered_at: null }],
    [readFixture, { read_at: null }],
    [failedFixture, { code: "4006" }],
    [failedFixture, { failed_at: null }],
    [failedFixture, { service: "WhatsApp" }],
    [failedFixture, { detail_code: 1.5 }],
  ] as const)("rejects malformed current lifecycle payloads", async (fixture, dataOverride) => {
    const payload = { ...fixture, data: { ...fixture.data, ...dataOverride } };

    await expect(
      createTestAdapter().verifyWebhook(createStandardRequest(payload)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_payload", status: 400 },
    });
  });

  it("reuses atomic dedupe and does not enter standard message/reaction dispatch", async () => {
    const context = await createContext();
    const named = vi.fn();
    const all = vi.fn();
    context.adapter.onLinqEvent("message.delivered", named);
    context.adapter.onLinqEvent(all);

    const first = await context.adapter.handleWebhook(createStandardRequest(deliveredFixture));
    const duplicate = await context.adapter.handleWebhook(
      createStandardRequest(deliveredFixture, "duplicate-lifecycle-attempt"),
    );

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(context.setIfNotExists).toHaveBeenCalledWith(
      `dedupe:linq:event:${deliveredFixture.partner_id}:${deliveredFixture.event_id}`,
      true,
      EVENT_DEDUPE_TTL_MS,
    );
    expect(named).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(context.processReaction).not.toHaveBeenCalled();
  });

  it("dispatches through the public Chat SDK webhook route", async () => {
    const adapter = createTestAdapter();
    const handler = vi.fn();
    const tasks: Promise<unknown>[] = [];
    const state = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      setIfNotExists: vi.fn().mockResolvedValue(true),
    } as unknown as StateAdapter;
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state,
      userName: "linq-lifecycle-test",
    });
    adapter.onLinqEvent("message.read", handler);

    const response = await chat.webhooks.linq(createStandardRequest(readFixture), {
      waitUntil: (task) => tasks.push(task),
    });
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.read",
        data: expect.objectContaining({ readAt: readFixture.data.read_at }),
      }),
    );
  });

  it("keeps accepted voice memo identity compatible with typed lossless lifecycle events", async () => {
    const adapter = createTestAdapter();
    const sendVoicememo = vi.fn().mockResolvedValue({
      voice_memo: {
        id: sentFixture.data.id,
        chat: { id: sentFixture.data.chat.id, is_group: sentFixture.data.chat.is_group },
        voice_memo: { id: VOICE_MEMO_ATTACHMENT_ID },
      },
    });
    Object.assign(adapter.client.chats, { sendVoicememo });
    const handler = vi.fn();
    const tasks: Promise<unknown>[] = [];
    const state = {
      appendToList: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      setIfNotExists: vi.fn().mockResolvedValue(true),
    } as unknown as StateAdapter;
    const chat = new Chat({
      adapters: { linq: adapter },
      logger: "silent",
      state,
      userName: "linq-voice-lifecycle-test",
    });
    await chat.initialize();
    adapter.onLinqEvent("message.sent", handler);

    const result = await adapter
      .conversation(`linq:${sentFixture.data.chat.id}`)
      .sendVoiceMemo({ attachmentId: VOICE_MEMO_ATTACHMENT_ID });
    const response = await chat.webhooks.linq(
      createStandardRequest(sentFixture, "voice-lifecycle-webhook-id"),
      { waitUntil: (task) => tasks.push(task) },
    );
    await Promise.all(tasks);

    expect(result).toEqual({
      messageId: sentFixture.data.id,
      threadId: `linq:${sentFixture.data.chat.id}`,
      attachmentId: VOICE_MEMO_ATTACHMENT_ID,
    });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ providerMessageId: result.messageId }),
        rawEvent: sentFixture,
      }),
    );
  });
});

function createTestAdapter(): LinqAdapter {
  return createLinqAdapter({ apiKey: "test_linq_api_key", signingSecret: SIGNING_SECRET });
}

async function createContext(adapter = createTestAdapter()): Promise<{
  adapter: LinqAdapter;
  processMessage: ReturnType<typeof vi.fn>;
  processReaction: ReturnType<typeof vi.fn>;
  setIfNotExists: ReturnType<typeof vi.fn>;
}> {
  const claimed = new Set<string>();
  const setIfNotExists = vi.fn(async (key: string) => {
    if (claimed.has(key)) {
      return false;
    }

    claimed.add(key);
    return true;
  });
  const processMessage = vi.fn(async () => {});
  const processReaction = vi.fn();
  const logger = createLogger();
  const chat = {
    getLogger: () => logger,
    getState: () => ({ setIfNotExists }) as unknown as StateAdapter,
    processMessage,
    processReaction,
  } as unknown as ChatInstance;

  await adapter.initialize(chat);
  return { adapter, processMessage, processReaction, setIfNotExists };
}

function createLogger(): Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return logger;
}

function createStandardRequest(payload: unknown, webhookId = "lifecycle-webhook-id"): Request {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v1,${createHmac("sha256", SIGNING_KEY)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest("base64")}`;

  return new Request("https://example.com/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-signature": signature,
      "webhook-timestamp": timestamp,
    },
    body,
  });
}
