import { LinqAPIV3 } from "@linqapp/sdk";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createLinqAdapter, LINQ_WEBHOOK_VERSION, LinqAdapter } from "../src/index.js";
import type {
  LinqAnyEvent,
  LinqAdapterConfig,
  LinqEventMap,
  LinqFutureEvent,
  LinqKnownEventType,
  LinqVerifiedUnhandledWebhook,
  LinqVerifiedWebhook,
  LinqWebhookVerificationResult,
} from "../src/index.js";

const API_KEY = "test_linq_api_key";
const BASE_URL = "https://sandbox.example.com/api/partner";
const SIGNING_SECRET = "test_linq_webhook_secret";

const config = {
  apiKey: API_KEY,
  baseURL: BASE_URL,
  signingSecret: SIGNING_SECRET,
} satisfies LinqAdapterConfig;

function assertClientCannotBeReassigned(adapter: LinqAdapter): void {
  // @ts-expect-error -- `client` is a read-only view of the internally used Linq client.
  adapter.client = new LinqAPIV3({ apiKey: "replacement" });
}

void assertClientCannotBeReassigned;

function assertVerifiedWebhookCannotBeConstructed(adapter: LinqAdapter): void {
  const structurallyComplete: Pick<
    LinqVerifiedUnhandledWebhook,
    "kind" | "envelope" | "transport" | "rawEvent"
  > = {
    kind: "unhandled",
    envelope: {
      provider: "linq",
      apiVersion: "v3",
      webhookVersion: LINQ_WEBHOOK_VERSION,
      versionStatus: "current",
      eventType: "message.delivered",
      eventId: "event-123",
      createdAt: "2026-08-02T12:00:00.000Z",
      traceId: "trace-123",
      partnerId: "partner-123",
    },
    transport: {
      scheme: "standard",
      webhookId: "webhook-123",
      timestamp: "1785672000",
      subscriptionId: null,
      eventType: null,
    },
    rawEvent: {},
  };

  // @ts-expect-error -- only verifyWebhook() can supply the private verified brand.
  void adapter.dispatchVerifiedWebhook(structurallyComplete);
}

void assertVerifiedWebhookCannotBeConstructed;

function assertAutoVerificationModeDoesNotCompile(): void {
  createLinqAdapter({
    apiKey: API_KEY,
    signingSecret: SIGNING_SECRET,
    // @ts-expect-error -- ambiguous automatic scheme inference is intentionally unsupported.
    webhookVerificationMode: "auto",
  });
}

void assertAutoVerificationModeDoesNotCompile;

function assertTypedEventRegistration(adapter: LinqAdapter): void {
  const unsubscribeMessage = adapter.onLinqEvent("message.received", (event) => {
    expectTypeOf(event.type).toEqualTypeOf<"message.received">();
    expectTypeOf(event.data).toEqualTypeOf<LinqAPIV3.MessageEventV2>();
    expectTypeOf(event.rawEvent).not.toBeAny();
  });
  const unsubscribeLifecycle = adapter.onLinqEvent(
    ["message.delivered", "message.failed"] as const,
    (event) => {
      expectTypeOf(event).toEqualTypeOf<
        LinqEventMap["message.delivered"] | LinqEventMap["message.failed"]
      >();
      if (event.type === "message.delivered") {
        expectTypeOf(event.data).toEqualTypeOf<LinqAPIV3.MessageEventV2>();
      } else {
        expectTypeOf(event.data).toEqualTypeOf<import("../src/index.js").LinqWebhookRawValue>();
      }
    },
  );
  const unsubscribeAll = adapter.onLinqEvent((event) => {
    expectTypeOf(event).toEqualTypeOf<LinqAnyEvent>();
  });

  expectTypeOf(unsubscribeMessage).toEqualTypeOf<() => void>();
  expectTypeOf(unsubscribeLifecycle).toEqualTypeOf<() => void>();
  expectTypeOf(unsubscribeAll).toEqualTypeOf<() => void>();

  // @ts-expect-error -- named registrations use the checked-in current event inventory.
  adapter.onLinqEvent("future.provider_event", () => {});
}

void assertTypedEventRegistration;

type Assert<T extends true> = T;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

type _KnownEventMapIsComplete = Assert<Equal<keyof LinqEventMap, LinqKnownEventType>>;

const futureEventContract = {
  type: "future.provider_event",
  data: { nested: ["lossless", 1, true, null] },
  envelope: {
    provider: "linq",
    apiVersion: "v3",
    webhookVersion: "2099-01-01",
    versionStatus: "future",
    eventType: "future.provider_event",
    eventId: "future-event-id",
    createdAt: "2099-01-01T00:00:00.000Z",
    traceId: "future-trace-id",
    partnerId: "future-partner-id",
  },
  transport: {
    scheme: "standard",
    webhookId: "future-webhook-id",
    timestamp: "4070908800",
    subscriptionId: null,
    eventType: null,
  },
  rawEvent: {
    api_version: "v3",
    webhook_version: "2099-01-01",
    event_type: "future.provider_event",
    event_id: "future-event-id",
    created_at: "2099-01-01T00:00:00.000Z",
    trace_id: "future-trace-id",
    partner_id: "future-partner-id",
    data: { nested: ["lossless", 1, true, null] },
  },
} as const satisfies LinqFutureEvent;

expectTypeOf(futureEventContract).toMatchTypeOf<LinqAnyEvent>();

describe("public adapter foundation", () => {
  it("exports the concrete adapter and preserves the factory return type", () => {
    const adapter = createLinqAdapter(config);

    expect(adapter).toBeInstanceOf(LinqAdapter);
    expectTypeOf(adapter).toEqualTypeOf<LinqAdapter>();
    expectTypeOf(createLinqAdapter).returns.toEqualTypeOf<LinqAdapter>();
  });

  it("rejects unsupported verification modes at runtime", () => {
    expect(() =>
      createLinqAdapter({
        apiKey: API_KEY,
        signingSecret: SIGNING_SECRET,
        webhookVerificationMode: "auto" as never,
      }),
    ).toThrow('webhookVerificationMode must be "standard" or "legacy"');
  });

  it("exposes the configured LinqAPIV3 client", () => {
    const adapter = createLinqAdapter(config);
    const client = adapter.client;

    expect(client).toBeInstanceOf(LinqAPIV3);
    expect(adapter.client).toBe(client);
    expectTypeOf(client).toEqualTypeOf<LinqAPIV3>();
    expect(client.apiKey).toBe(API_KEY);
    expect(client.baseURL).toBe(BASE_URL);
    expect(client.webhookSecret).toBeNull();
    expectTypeOf(client.blockedHandles.list).toBeFunction();
    expectTypeOf(client.chats.background.set).toBeFunction();
    expectTypeOf(client.chats.polls.create).toBeFunction();
    expectTypeOf(client.messages.poll.retrieve).toBeFunction();
    expectTypeOf(client.phoneNumbers.startReputationAudit).toBeFunction();
    expectTypeOf(client.experiences.list).toBeFunction();
  });

  it("implements Chat SDK standard reply/read without enabling local history", () => {
    const adapter = createLinqAdapter(config);

    expectTypeOf(adapter.reply).toBeFunction();
    expectTypeOf(adapter.markAsRead).toBeFunction();
    expect(adapter).not.toHaveProperty("persistMessageHistory");
  });

  it("exports the two-phase verified webhook contract", () => {
    const adapter = createLinqAdapter(config);

    expect(LINQ_WEBHOOK_VERSION).toBe("2026-02-03");
    expectTypeOf(
      adapter.verifyWebhook,
    ).returns.resolves.toEqualTypeOf<LinqWebhookVerificationResult>();
    expectTypeOf(adapter.dispatchVerifiedWebhook).parameter(0).toEqualTypeOf<LinqVerifiedWebhook>();
  });

  it("registers typed Linq event handlers and validates runtime forms", () => {
    const adapter = createLinqAdapter(config);
    const unsubscribe = adapter.onLinqEvent("message.sent", vi.fn());

    expect(unsubscribe).toBeTypeOf("function");
    expect(() => adapter.onLinqEvent([] as never, vi.fn())).toThrow(
      "onLinqEvent requires at least one event type",
    );
    expect(() => adapter.onLinqEvent("future.provider_event" as never, vi.fn())).toThrow(
      "Unsupported Linq event type",
    );
    expect(() => adapter.onLinqEvent("message.sent" as never)).toThrow(
      "onLinqEvent requires a handler",
    );
  });

  it("uses the exposed client instance for internal adapter operations", async () => {
    const adapter = createLinqAdapter(config);
    const client = adapter.client;
    const send = vi.spyOn(client.chats.messages, "send").mockResolvedValue({
      chat_id: "chat-123",
      message: {
        id: "message-123",
        created_at: "2026-08-02T12:00:00.000Z",
        delivery_status: "queued",
        is_read: false,
        parts: [{ type: "text", value: "hello", reactions: null }],
        sent_at: null,
      },
    });

    await adapter.postMessage("linq:chat-123", "hello");

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [{ type: "text", value: "hello" }],
      },
    });
  });
});
