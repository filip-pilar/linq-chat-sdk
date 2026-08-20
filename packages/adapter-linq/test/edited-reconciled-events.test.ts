import { createHmac } from "node:crypto";

import type { LinqAPIV3 } from "@linqapp/sdk";
import { Chat } from "chat";
import type { ChatInstance, Logger, StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, type LinqAdapter } from "../src/index.js";
import editedFixture from "./fixtures/message-edited-2026-02-03.json";
import receivedFixture from "./fixtures/message-received-2026-02-03.json";
import reconciledFixture from "./fixtures/message-reconciled-2026-02-03.json";

const SIGNING_KEY = "test_linq_webhook_secret";
const SIGNING_SECRET = `whsec_${Buffer.from(SIGNING_KEY).toString("base64")}`;
const EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;

describe("typed edited and reconciled Linq messages", () => {
  it("normalizes a confirmed text-part edit and preserves unknown fields losslessly", async () => {
    const payload = {
      ...editedFixture,
      data: {
        ...editedFixture.data,
        future_context: { source: "provider" },
        part: { ...editedFixture.data.part, future_part_fact: true },
      },
    };

    const result = await createTestAdapter().verifyWebhook(createStandardRequest(payload));

    expect(result).toMatchObject({
      ok: true,
      webhook: {
        kind: "message.edited",
        edit: {
          providerMessageId: editedFixture.data.id,
          chatId: editedFixture.data.chat.id,
          conversationKind: "direct",
          direction: "outbound",
          senderHandle: {
            id: editedFixture.data.sender_handle.id,
            endpoint: { kind: "phone", value: "+15550001000" },
          },
          partIndex: 0,
          text: "Edited lifecycle fixture",
          editedAt: editedFixture.data.edited_at,
        },
        rawEvent: payload,
      },
    });
    if (result.ok) {
      expect(Object.isFrozen(result.webhook.rawEvent)).toBe(true);
      expect(result.webhook.rawEvent.data).toMatchObject({
        future_context: { source: "provider" },
        part: { future_part_fact: true },
      });
    }
  });

  it.each([
    ["message id", { ...editedFixture.data, id: "" }],
    [
      "group marker",
      { ...editedFixture.data, chat: { ...editedFixture.data.chat, is_group: null } },
    ],
    [
      "owner handle",
      { ...editedFixture.data, chat: { ...editedFixture.data.chat, owner_handle: null } },
    ],
    [
      "health status",
      { ...editedFixture.data, chat: { ...editedFixture.data.chat, health_status: null } },
    ],
    ["sender handle", { ...editedFixture.data, sender_handle: null }],
    ["part index", { ...editedFixture.data, part: { ...editedFixture.data.part, index: -1 } }],
    ["part text", { ...editedFixture.data, part: { ...editedFixture.data.part, text: 42 } }],
    ["edit timestamp", { ...editedFixture.data, edited_at: "" }],
  ])("rejects malformed edited payload %s", async (_label, data) => {
    const payload = { ...editedFixture, data };

    await expect(
      createTestAdapter().verifyWebhook(createStandardRequest(payload)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_payload", status: 400 },
    });
  });

  it.each(["2025-01-01", "2099-01-01", "preview"])(
    "keeps edited payload version %s lossless without current-schema typing",
    async (webhookVersion) => {
      const payload = { ...editedFixture, webhook_version: webhookVersion };

      await expect(
        createTestAdapter().verifyWebhook(createStandardRequest(payload)),
      ).resolves.toMatchObject({
        ok: true,
        webhook: {
          kind: "unsupported_version",
          envelope: { webhookVersion },
          rawEvent: payload,
        },
      });
    },
  );

  it("reuses atomic dedupe and keeps edits out of standard message/reaction dispatch", async () => {
    const context = await createContext();
    const named = vi.fn();
    context.adapter.onLinqEvent("message.edited", named);

    const first = await context.adapter.handleWebhook(createStandardRequest(editedFixture));
    const duplicate = await context.adapter.handleWebhook(
      createStandardRequest(editedFixture, "duplicate-edit-attempt"),
    );

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(context.setIfNotExists).toHaveBeenCalledWith(
      `dedupe:linq:event:${editedFixture.partner_id}:${editedFixture.event_id}`,
      true,
      EVENT_DEDUPE_TTL_MS,
    );
    expect(named).toHaveBeenCalledTimes(1);
    expect(named).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.edited",
        data: expect.objectContaining({ providerMessageId: editedFixture.data.id }),
      }),
    );
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(context.processReaction).not.toHaveBeenCalled();
  });

  it("delivers a recovered message generically without treating it as newly received", async () => {
    const context = await createContext();
    const named = vi.fn();
    context.adapter.onLinqEvent("message.received", named);

    const first = await context.adapter.handleWebhook(createStandardRequest(reconciledFixture));
    const duplicate = await context.adapter.handleWebhook(
      createStandardRequest(reconciledFixture, "duplicate-reconciled-attempt"),
    );

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(named).toHaveBeenCalledTimes(1);
    expect(named).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.received",
        data: expect.objectContaining({ reconciled_at: reconciledFixture.data.reconciled_at }),
      }),
    );
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(context.processReaction).not.toHaveBeenCalled();

    const verification = await createTestAdapter().verifyWebhook(
      createStandardRequest(reconciledFixture),
    );
    expect(verification).toMatchObject({
      ok: true,
      webhook: {
        kind: "message.received",
        message: {
          providerMessageId: reconciledFixture.data.id,
          timestamps: { reconciledAt: reconciledFixture.data.reconciled_at },
        },
      },
    });
  });

  it.each([null, ""])("rejects malformed reconciled_at=%s", async (reconciledAt) => {
    const payload = {
      ...reconciledFixture,
      data: { ...reconciledFixture.data, reconciled_at: reconciledAt },
    };

    await expect(
      createTestAdapter().verifyWebhook(createStandardRequest(payload)),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_payload", status: 400 },
    });
  });

  it("keeps ordinary current inbound messages on standard dispatch", async () => {
    const context = await createContext();

    const response = await context.adapter.handleWebhook(createStandardRequest(receivedFixture));

    expect(response.status).toBe(200);
    expect(context.processMessage).toHaveBeenCalledTimes(1);
  });

  it("uses the public Chat webhook route without surfacing edits or recovered history as new DMs", async () => {
    const adapter = createTestAdapter();
    const generic = vi.fn();
    const directMessage = vi.fn();
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
      userName: "linq-edited-reconciled-test",
    });
    adapter.onLinqEvent(["message.edited", "message.received"], generic);
    chat.onDirectMessage(directMessage);

    const editedResponse = await chat.webhooks.linq(createStandardRequest(editedFixture), {
      waitUntil: (task) => tasks.push(task),
    });
    const reconciledResponse = await chat.webhooks.linq(createStandardRequest(reconciledFixture), {
      waitUntil: (task) => tasks.push(task),
    });
    await Promise.all(tasks);

    expect(editedResponse.status).toBe(200);
    expect(reconciledResponse.status).toBe(200);
    expect(generic).toHaveBeenCalledTimes(2);
    expect(directMessage).not.toHaveBeenCalled();
  });

  it("correlates a refresh by provider ID and treats a deleted-message refresh as a tombstone", async () => {
    const adapter = createTestAdapter();
    const retrieve = vi.spyOn(adapter.client.messages, "retrieve");
    retrieve.mockResolvedValueOnce(refreshedMessage());

    const refreshed = await adapter.fetchMessage(
      `linq:${editedFixture.data.chat.id}`,
      editedFixture.data.id,
    );

    expect(retrieve).toHaveBeenCalledWith(editedFixture.data.id);
    expect(refreshed).toMatchObject({
      id: editedFixture.data.id,
      threadId: `linq:${editedFixture.data.chat.id}`,
      text: editedFixture.data.part.text,
      metadata: { edited: false },
    });
    expect(refreshed?.raw).toMatchObject({ reconciled_at: "2026-05-08T18:00:00.000Z" });

    retrieve.mockRejectedValueOnce({ status: 404 });
    await expect(
      adapter.fetchMessage(`linq:${editedFixture.data.chat.id}`, editedFixture.data.id),
    ).resolves.toBeNull();
  });
});

function createTestAdapter(): LinqAdapter {
  return createLinqAdapter({ apiKey: "test_linq_api_key", signingSecret: SIGNING_SECRET });
}

async function createContext(): Promise<{
  adapter: LinqAdapter;
  processMessage: ReturnType<typeof vi.fn>;
  processReaction: ReturnType<typeof vi.fn>;
  setIfNotExists: ReturnType<typeof vi.fn>;
}> {
  const adapter = createTestAdapter();
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

function refreshedMessage(): LinqAPIV3.Message {
  return {
    id: editedFixture.data.id,
    chat_id: editedFixture.data.chat.id,
    created_at: "2026-05-08T16:21:12.499Z",
    updated_at: "2026-05-08T18:00:00.000Z",
    delivery_status: "delivered",
    is_delivered: true,
    is_from_me: true,
    is_read: false,
    parts: [{ type: "text", value: editedFixture.data.part.text, reactions: null }],
    reconciled_at: "2026-05-08T18:00:00.000Z",
    sent_at: "2026-05-08T16:21:12.499Z",
  };
}

function createStandardRequest(
  payload: unknown,
  webhookId = "edited-reconciled-webhook-id",
): Request {
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
