import { LinqAPIV3 } from "@linqapp/sdk";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createLinqAdapter, LinqAdapter } from "../src/index.js";
import type { LinqAdapterConfig } from "../src/index.js";

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
      message: { parts: [{ type: "text", value: "hello" }] },
    });
  });
});
