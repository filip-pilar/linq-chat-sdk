import { LinqAPIV3 } from "@linqapp/sdk";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createLinqAdapter, LINQ_WEBHOOK_VERSION, LinqAdapter } from "../src/index.js";
import type {
  LinqAdapterConfig,
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

describe("public adapter foundation", () => {
  it("exports the concrete adapter and preserves the factory return type", () => {
    const adapter = createLinqAdapter(config);

    expect(adapter).toBeInstanceOf(LinqAdapter);
    expectTypeOf(adapter).toEqualTypeOf<LinqAdapter>();
    expectTypeOf(createLinqAdapter).returns.toEqualTypeOf<LinqAdapter>();
  });

  it("exposes the configured LinqAPIV3 client", () => {
    const adapter = createLinqAdapter(config);
    const client = adapter.client;

    expect(client).toBeInstanceOf(LinqAPIV3);
    expect(adapter.client).toBe(client);
    expectTypeOf(client).toEqualTypeOf<LinqAPIV3>();
    expect(client.apiKey).toBe(API_KEY);
    expect(client.baseURL).toBe(BASE_URL);
    expect(client.webhookSecret).toBe(SIGNING_SECRET);
  });

  it("exports the two-phase verified webhook contract", () => {
    const adapter = createLinqAdapter(config);

    expect(LINQ_WEBHOOK_VERSION).toBe("2026-02-03");
    expectTypeOf(
      adapter.verifyWebhook,
    ).returns.resolves.toEqualTypeOf<LinqWebhookVerificationResult>();
    expectTypeOf(adapter.dispatchVerifiedWebhook).parameter(0).toEqualTypeOf<LinqVerifiedWebhook>();
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
