import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";

const SIGNING_SECRET = "whsec_c2hoaC10aGlzLWlzLWEtdGVzdC1zZWNyZXQtdmFsdWU=";
const API_KEY = "test_linq_api_key";
const CHAT_ID = "9c1f0a2e-3d4b-4c5d-8e9f-0a1b2c3d4e5f";
const MESSAGE_ID = "0f2b6f77-4a0e-4a3e-9d5f-8f2f6b8e1c11";

/**
 * Chat SDK has no delivery-status dispatch, so these surface on the adapter.
 * Without them a caller cannot tell a delivered message from one the carrier
 * rejected — the agent believes every send succeeded.
 */
describe("message lifecycle events", () => {
  it("reports a failed delivery", async () => {
    const adapter = createTestAdapter();
    const onDeliveryStatus = vi.fn();
    adapter.onDeliveryStatus(onDeliveryStatus);

    const response = await adapter.handleWebhook(
      signed(
        lifecycle("message.failed", {
          error: { code: 2008, message: "Recipient not allowed" },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(onDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        threadId: `linq:${CHAT_ID}`,
        messageId: MESSAGE_ID,
      }),
    );
  });

  it("reports delivered and read", async () => {
    for (const [eventType, status] of [
      ["message.delivered", "delivered"],
      ["message.read", "read"],
    ] as const) {
      const adapter = createTestAdapter();
      const onDeliveryStatus = vi.fn();
      adapter.onDeliveryStatus(onDeliveryStatus);

      await adapter.handleWebhook(signed(lifecycle(eventType)));

      expect(onDeliveryStatus, eventType).toHaveBeenCalledWith(
        expect.objectContaining({ status, messageId: MESSAGE_ID }),
      );
    }
  });

  it("does not report an inbound message as delivery status", async () => {
    const adapter = createTestAdapter();
    const onDeliveryStatus = vi.fn();
    adapter.onDeliveryStatus(onDeliveryStatus);

    await adapter.handleWebhook(signed(lifecycle("message.received")));

    expect(onDeliveryStatus).not.toHaveBeenCalled();
  });

  it("survives a listener that throws, so one bad handler cannot drop a webhook", async () => {
    const adapter = createTestAdapter();
    adapter.onDeliveryStatus(() => {
      throw new Error("listener exploded");
    });

    const response = await adapter.handleWebhook(signed(lifecycle("message.failed")));

    expect(response.status).toBe(200);
  });
});

function createTestAdapter() {
  return createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
}

function signed(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const id = "msg_lifecycle";
  const timestamp = new Date();
  const signature = new Webhook(SIGNING_SECRET).sign(id, timestamp, body);

  return new Request("https://example.com/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
      "webhook-signature": signature,
    },
    body,
  });
}

function lifecycle(eventType: string, extra: Record<string, unknown> = {}) {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: eventType,
    event_id: `lifecycle-${eventType}`,
    created_at: "2026-08-20T00:00:00.000Z",
    trace_id: "lifecycle",
    partner_id: "lifecycle",
    data: {
      id: MESSAGE_ID,
      direction: eventType === "message.received" ? "inbound" : "outbound",
      chat: { id: CHAT_ID, is_group: false },
      sender_handle: { handle: "+12025550147", service: "iMessage" },
      service: "iMessage",
      parts: [{ type: "text", value: "hello" }],
      sent_at: "2026-08-20T00:00:00.000Z",
      ...extra,
    },
  };
}
