import { createHmac } from "node:crypto";

import type { ChatInstance, Logger, StateAdapter } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter, type LinqAdapter } from "../src/index.js";
import fixture from "./fixtures/message-received-2026-02-03.json";
import unknownFixture from "./fixtures/unknown-event-2026-02-03.json";

const SIGNING_KEY = "test_linq_webhook_secret";
const SIGNING_SECRET = `whsec_${Buffer.from(SIGNING_KEY).toString("base64")}`;
const EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;

describe("verified generic Linq event dispatch", () => {
  it.each([
    "chat.created",
    "chat.group_name_updated",
    "participant.added",
    "chat.typing_indicator.started",
    "phone_number.status_updated",
    "call.answered",
  ] as const)(
    "delivers valid canonical raw-only %s events to named and generic handlers",
    async (eventType) => {
      const context = await createContext();
      const named = vi.fn();
      const all = vi.fn();
      const tasks: Promise<unknown>[] = [];
      const retrieve = vi.spyOn(context.adapter.client.chats, "retrieve");
      const payload = rawKnownPayload(eventType);
      context.adapter.onLinqEvent(eventType, named);
      context.adapter.onLinqEvent(all);

      const response = await context.adapter.handleWebhook(createStandardRequest(payload), {
        waitUntil: (task) => tasks.push(task),
      });
      await Promise.all(tasks);

      expect(response.status).toBe(200);
      expect(named).toHaveBeenCalledOnce();
      expect(all).toHaveBeenCalledOnce();
      expect(named).toHaveBeenCalledWith(
        expect.objectContaining({ type: eventType, data: payload.data, rawEvent: payload }),
      );
      expect(all).toHaveBeenCalledWith(
        expect.objectContaining({ type: eventType, data: payload.data, rawEvent: payload }),
      );
      expect(context.processMessage).not.toHaveBeenCalled();
      expect(context.processReaction).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
    },
  );

  it("isolates and dedupes raw-only named callbacks while preserving listener removal", async () => {
    const context = await createContext();
    const failure = new Error("raw-only callback failed");
    const failed = vi.fn(async () => {
      throw failure;
    });
    const sibling = vi.fn();
    const payload = rawKnownPayload("chat.created");
    const tasks: Promise<unknown>[] = [];
    context.adapter.onLinqEvent("chat.created", failed);
    const unsubscribe = context.adapter.onLinqEvent("chat.created", sibling);

    const first = await context.adapter.handleWebhook(createStandardRequest(payload), {
      waitUntil: (task) => tasks.push(task),
    });
    await Promise.all(tasks);
    unsubscribe();
    const duplicate = await context.adapter.handleWebhook(
      createStandardRequest(payload, { "webhook-id": "raw-only-duplicate" }),
    );

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(failed).toHaveBeenCalledOnce();
    expect(sibling).toHaveBeenCalledOnce();
    expect(context.logger.error).toHaveBeenCalledWith("Linq event handler failed", {
      error: failure,
      eventType: "chat.created",
    });
  });

  it("delivers trusted-forwarded raw-only known events through the same named seam", async () => {
    const adapter = createLinqAdapter({ apiKey: "test_linq_api_key", webhookVerifier: () => true });
    const context = await createContext(adapter);
    const named = vi.fn();
    const all = vi.fn();
    const payload = rawKnownPayload("participant.added");
    const rawBody = `${JSON.stringify(payload)}\n`;
    const tasks: Promise<unknown>[] = [];
    adapter.onLinqEvent("participant.added", named);
    adapter.onLinqEvent(all);

    const response = await adapter.handleWebhook(
      new Request("https://forwarder.example.test/linq", { method: "POST", body: rawBody }),
      { waitUntil: (task) => tasks.push(task) },
    );
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(named).toHaveBeenCalledWith(
      expect.objectContaining({ type: "participant.added", rawEvent: payload }),
    );
    expect(all).toHaveBeenCalledOnce();
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(context.processReaction).not.toHaveBeenCalled();
  });

  it("atomically claims before standard and generic message dispatch", async () => {
    const context = await createContext();
    const named = vi.fn();
    const all = vi.fn();
    context.adapter.onLinqEvent("message.received", named);
    context.adapter.onLinqEvent(all);

    const response = await context.adapter.handleWebhook(createStandardRequest(fixture));

    expect(response.status).toBe(200);
    expect(context.setIfNotExists).toHaveBeenCalledWith(
      `dedupe:linq:event:${fixture.partner_id}:${fixture.event_id}`,
      true,
      EVENT_DEDUPE_TTL_MS,
    );
    expect(context.processMessage).toHaveBeenCalledTimes(1);
    expect(context.processMessage).toHaveBeenCalledWith(
      context.adapter,
      `linq:${fixture.data.chat.id}`,
      expect.any(Function),
      undefined,
    );
    expect(named).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
    expect(named.mock.calls[0]?.[0]).toMatchObject({
      type: "message.received",
      data: { id: fixture.data.id },
      envelope: { eventId: fixture.event_id, partnerId: fixture.partner_id },
      rawEvent: fixture,
    });
  });

  it("keeps an unclassified message in generic dispatch without provider lookup", async () => {
    const context = await createContext();
    const generic = vi.fn();
    const tasks: Promise<unknown>[] = [];
    const retrieve = vi.spyOn(context.adapter.client.chats, "retrieve");
    const payload = structuredClone(fixture) as unknown as {
      data: { chat: { is_group: boolean | null } };
    };
    payload.data.chat.is_group = null;
    context.adapter.onLinqEvent("message.received", generic);

    const response = await context.adapter.handleWebhook(createStandardRequest(payload), {
      waitUntil: (task) => tasks.push(task),
    });
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(retrieve).not.toHaveBeenCalled();
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(generic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.received",
        rawEvent: expect.objectContaining({
          data: expect.objectContaining({ chat: payload.data.chat }),
        }),
      }),
    );
  });

  it.each(["message.received", "message.delivered", "reaction.added", "location.sharing.started"])(
    "acknowledges authenticated malformed %s losslessly without false curated dispatch",
    async (eventType) => {
      const context = await createContext();
      const named = vi.fn();
      const all = vi.fn();
      const delivery = vi.fn();
      const retrieve = vi.spyOn(context.adapter.client.chats, "retrieve");
      const payload = {
        ...fixture,
        event_id: `malformed-${eventType}`,
        event_type: eventType,
        data: { malformed: true, nested: [1, null, { future: true }] },
      };
      const rawBody = JSON.stringify(payload);
      context.adapter.onLinqEvent(eventType as never, named);
      context.adapter.onLinqEvent(all);
      context.adapter.onDeliveryStatus(delivery);

      const verification = await context.adapter.verifyWebhook(createStandardRequest(payload));
      expect(verification).toMatchObject({
        ok: true,
        webhook: { kind: "unhandled", rawBody, rawEvent: payload },
      });
      if (!verification.ok) throw new Error("Expected authenticated malformed event");
      expect(Buffer.from(verification.webhook.rawBodyBase64, "base64").toString()).toBe(rawBody);

      const first = await context.adapter.handleWebhook(createStandardRequest(payload));
      const duplicate = await context.adapter.handleWebhook(
        createStandardRequest(payload, { "webhook-id": `duplicate-${eventType}` }),
      );

      expect(first.status).toBe(200);
      expect(duplicate.status).toBe(200);
      expect(named).not.toHaveBeenCalled();
      expect(all).toHaveBeenCalledOnce();
      expect(all).toHaveBeenCalledWith(
        expect.objectContaining({ type: eventType, data: payload.data, rawEvent: payload }),
      );
      expect(delivery).not.toHaveBeenCalled();
      expect(context.processMessage).not.toHaveBeenCalled();
      expect(context.processReaction).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
    },
  );

  it("keeps an authenticated received message with an untruthful timestamp generic-only", async () => {
    const context = await createContext();
    const named = vi.fn();
    const all = vi.fn();
    const payload = structuredClone(fixture);
    payload.event_id = "malformed-received-timestamp";
    payload.data.sent_at = "2026-02-30T00:00:00Z";
    context.adapter.onLinqEvent("message.received", named);
    context.adapter.onLinqEvent(all);

    const response = await context.adapter.handleWebhook(createStandardRequest(payload));

    expect(response.status).toBe(200);
    expect(named).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message.received", rawEvent: payload }),
    );
    expect(context.processMessage).not.toHaveBeenCalled();
  });

  it("keeps a schema-valid leap-second message typed without inventing a Chat SDK Date", async () => {
    const context = await createContext();
    const named = vi.fn();
    const all = vi.fn();
    const payload = structuredClone(fixture);
    payload.event_id = "received-leap-second";
    payload.data.sent_at = "2016-12-31T23:59:60Z";
    context.adapter.onLinqEvent("message.received", named);
    context.adapter.onLinqEvent(all);

    const response = await context.adapter.handleWebhook(createStandardRequest(payload));

    expect(response.status).toBe(200);
    expect(named).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.received",
        data: expect.objectContaining({ sent_at: "2016-12-31T23:59:60Z" }),
        rawEvent: payload,
      }),
    );
    expect(all).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.received",
        data: expect.objectContaining({ sent_at: "2016-12-31T23:59:60Z" }),
        rawEvent: payload,
      }),
    );
    expect(context.processMessage).not.toHaveBeenCalled();
  });

  it("suppresses concurrent duplicate standard and generic attempts", async () => {
    const context = await createContext();
    const handler = vi.fn();
    context.adapter.onLinqEvent(handler);

    const responses = await Promise.all([
      context.adapter.handleWebhook(createStandardRequest(fixture, { "webhook-id": "attempt-1" })),
      context.adapter.handleWebhook(createStandardRequest(fixture, { "webhook-id": "attempt-2" })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(context.setIfNotExists).toHaveBeenCalledTimes(2);
    expect(context.processMessage).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isolates generic callback failures from siblings and standard dispatch", async () => {
    const context = await createContext();
    const failure = new Error("consumer callback failed");
    const failed = vi.fn(async () => {
      throw failure;
    });
    const sibling = vi.fn();
    const tasks: Promise<unknown>[] = [];
    context.adapter.onLinqEvent("message.received", failed);
    context.adapter.onLinqEvent("message.received", sibling);

    const response = await context.adapter.handleWebhook(createStandardRequest(fixture), {
      waitUntil: (task) => tasks.push(task),
    });
    await tasks[0];

    expect(response.status).toBe(200);
    expect(context.processMessage).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(context.logger.error).toHaveBeenCalledWith("Linq event handler failed", {
      error: failure,
      eventType: "message.received",
    });

    const duplicateResponse = await context.adapter.handleWebhook(
      createStandardRequest(fixture, { "webhook-id": "retry-after-handler-failure" }),
    );
    expect(duplicateResponse.status).toBe(200);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(context.processMessage).toHaveBeenCalledTimes(1);
  });

  it("attempts generic siblings when standard dispatch fails", async () => {
    const context = await createContext();
    const handler = vi.fn();
    const failure = new Error("standard dispatch failed");
    context.processMessage.mockImplementationOnce(() => {
      throw failure;
    });
    context.adapter.onLinqEvent("message.received", handler);

    await expect(context.adapter.handleWebhook(createStandardRequest(fixture))).rejects.toThrow(
      failure,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("coexists with standard reaction dispatch", async () => {
    const context = await createContext();
    const handler = vi.fn();
    context.adapter.onLinqEvent(["reaction.added", "reaction.removed"], handler);
    const reaction = reactionPayload();

    const response = await context.adapter.handleWebhook(createStandardRequest(reaction));

    expect(response.status).toBe(200);
    expect(context.processReaction).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.added",
        data: expect.objectContaining({ reaction_type: "like" }),
      }),
    );
  });

  it("acknowledges without waiting for a slow generic callback", async () => {
    const context = await createContext();
    const deferred = createDeferred();
    const handler = vi.fn(() => deferred.promise);
    context.adapter.onLinqEvent(handler);

    const response = await context.adapter.handleWebhook(createStandardRequest(unknownFixture));

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    deferred.resolve();
    await deferred.promise;
  });

  it("registers generic callback completion with waitUntil", async () => {
    const context = await createContext();
    const deferred = createDeferred();
    const handler = vi.fn(() => deferred.promise);
    const tasks: Promise<unknown>[] = [];
    context.adapter.onLinqEvent(handler);

    const response = await context.adapter.handleWebhook(createStandardRequest(unknownFixture), {
      waitUntil: (task) => tasks.push(task),
    });

    expect(response.status).toBe(200);
    expect(tasks).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);

    let completed = false;
    void tasks[0]?.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    deferred.resolve();
    await tasks[0];
    expect(completed).toBe(true);
  });

  it("acknowledges a duplicate while the claimed callback is still running", async () => {
    const context = await createContext();
    const deferred = createDeferred();
    const handler = vi.fn(() => deferred.promise);
    const tasks: Promise<unknown>[] = [];
    context.adapter.onLinqEvent(handler);

    const first = await context.adapter.handleWebhook(createStandardRequest(unknownFixture), {
      waitUntil: (task) => tasks.push(task),
    });
    const duplicate = await context.adapter.handleWebhook(
      createStandardRequest(unknownFixture, { "webhook-id": "pending-callback-replay" }),
      { waitUntil: (task) => tasks.push(task) },
    );

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(1);
    deferred.resolve();
    await tasks[0];
  });

  it("uses the same waitUntil scheduling in two-phase dispatch", async () => {
    const context = await createContext();
    const deferred = createDeferred();
    const tasks: Promise<unknown>[] = [];
    context.adapter.onLinqEvent(() => deferred.promise);
    const verification = await context.adapter.verifyWebhook(createStandardRequest(unknownFixture));

    if (!verification.ok) {
      throw new Error("Expected verification success");
    }

    const result = await context.adapter.dispatchVerifiedWebhook(verification.webhook, {
      waitUntil: (task) => tasks.push(task),
    });

    expect(result).toEqual({ handled: "ignored" });
    expect(tasks).toHaveLength(1);
    deferred.resolve();
    await tasks[0];
  });

  it("delivers current unknown names losslessly only to all-event handlers", async () => {
    const context = await createContext();
    const all = vi.fn();
    context.adapter.onLinqEvent(all);

    const response = await context.adapter.handleWebhook(createStandardRequest(unknownFixture));

    expect(response.status).toBe(200);
    expect(all).toHaveBeenCalledTimes(1);
    const event = all.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      type: "future.provider_event",
      data: ["opaque", { nested: true }],
      rawEvent: unknownFixture,
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.rawEvent)).toBe(true);
    expect(context.processMessage).not.toHaveBeenCalled();
    expect(context.processReaction).not.toHaveBeenCalled();
  });

  it("keeps older/future versions out of schema-specific handlers", async () => {
    for (const webhookVersion of ["2025-01-01", "2099-01-01"]) {
      const context = await createContext();
      const named = vi.fn();
      const all = vi.fn();
      context.adapter.onLinqEvent("message.received", named);
      context.adapter.onLinqEvent(all);
      const payload = { ...fixture, webhook_version: webhookVersion };

      const response = await context.adapter.handleWebhook(createStandardRequest(payload));

      expect(response.status).toBe(200);
      expect(named).not.toHaveBeenCalled();
      expect(all).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "message.received",
          envelope: expect.objectContaining({ webhookVersion }),
          rawEvent: payload,
        }),
      );
      expect(context.processMessage).toHaveBeenCalledTimes(webhookVersion < "2026" ? 1 : 0);
    }
  });

  it("does not collide across authenticated partner identities", async () => {
    const context = await createContext();
    const handler = vi.fn();
    context.adapter.onLinqEvent(handler);
    const otherPartner = { ...fixture, partner_id: "other-partner-id" };

    await context.adapter.handleWebhook(createStandardRequest(fixture));
    await context.adapter.handleWebhook(createStandardRequest(otherPartner));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(context.processMessage).toHaveBeenCalledTimes(2);
  });
});

async function createContext(
  adapter = createLinqAdapter({
    apiKey: "test_linq_api_key",
    signingSecret: SIGNING_SECRET,
  }),
): Promise<{
  adapter: LinqAdapter;
  logger: Logger & { error: ReturnType<typeof vi.fn> };
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
  const state = { setIfNotExists } as unknown as StateAdapter;
  const logger = createLogger();
  const processMessage = vi.fn(async () => {});
  const processReaction = vi.fn();
  const chat = {
    getLogger: () => logger,
    getState: () => state,
    processMessage,
    processReaction,
  } as unknown as ChatInstance;
  await adapter.initialize(chat);
  return { adapter, logger, processMessage, processReaction, setIfNotExists };
}

function rawKnownPayload(eventType: string): Record<string, unknown> {
  return {
    ...fixture,
    event_id: `raw-${eventType}`,
    event_type: eventType,
    data: Object.freeze({ provider_fact: eventType, nested: [1, true, null] }),
  };
}

function createLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  return logger;
}

function reactionPayload(): Record<string, unknown> {
  return {
    ...fixture,
    event_type: "reaction.added",
    data: {
      is_from_me: false,
      reaction_type: "like",
      chat_id: fixture.data.chat.id,
      message_id: fixture.data.id,
      part_index: 0,
      custom_emoji: null,
      reacted_at: "2026-05-08T16:22:00.000Z",
      service: "iMessage",
      from_handle: fixture.data.sender_handle,
    },
  };
}

function createStandardRequest(payload: unknown, overrides: Record<string, string> = {}): Request {
  const body = JSON.stringify(payload);
  const timestamp = overrides["webhook-timestamp"] ?? Math.floor(Date.now() / 1000).toString();
  const webhookId = overrides["webhook-id"] ?? "webhook-test-id";
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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}
