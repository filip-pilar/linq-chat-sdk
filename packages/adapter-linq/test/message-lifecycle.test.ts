import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter.js";
import deliveredFixture from "./fixtures/message-delivered-2026-02-03.json";
import failedFixture from "./fixtures/message-failed-2026-02-03.json";
import receivedFixture from "./fixtures/message-received-2026-02-03.json";
import readFixture from "./fixtures/message-read-2026-02-03.json";
import sentFixture from "./fixtures/message-sent-2026-02-03.json";

const SIGNING_SECRET = "whsec_c2hoaC10aGlzLWlzLWEtdGVzdC1zZWNyZXQtdmFsdWU=";
const API_KEY = "test_linq_api_key";

describe("onDeliveryStatus compatibility", () => {
  it.each([
    [sentFixture, "sent"],
    [deliveredFixture, "delivered"],
    [readFixture, "read"],
  ] as const)("reports authenticated %s lifecycle facts", async (fixture, status) => {
    const adapter = createTestAdapter();
    const listener = vi.fn();
    adapter.onDeliveryStatus(listener);

    const response = await adapter.handleWebhook(signed(fixture));

    expect(response.status).toBe(200);
    expect(listener).toHaveBeenCalledWith({
      status,
      threadId: `linq:${fixture.data.chat.id}`,
      messageId: fixture.data.id,
      raw: fixture,
    });
  });

  it("reports canonical failure facts", async () => {
    const adapter = createTestAdapter();
    const listener = vi.fn();
    adapter.onDeliveryStatus(listener);

    const response = await adapter.handleWebhook(signed(failedFixture));

    expect(response.status).toBe(200);
    expect(listener).toHaveBeenCalledWith({
      status: "failed",
      threadId: `linq:${failedFixture.data.chat_id}`,
      messageId: failedFixture.data.message_id,
      error: { code: failedFixture.data.code, message: failedFixture.data.reason },
      raw: failedFixture,
    });
  });

  it("does not report inbound messages as delivery status", async () => {
    const adapter = createTestAdapter();
    const listener = vi.fn();
    adapter.onDeliveryStatus(listener);

    await adapter.handleWebhook(signed(receivedFixture));

    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates listener failures from acknowledgement", async () => {
    const adapter = createTestAdapter();
    adapter.onDeliveryStatus(() => {
      throw new Error("listener exploded");
    });

    await expect(adapter.handleWebhook(signed(failedFixture))).resolves.toMatchObject({
      status: 200,
    });
  });
});

function createTestAdapter() {
  return createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
}

function signed(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const id = `msg_${crypto.randomUUID()}`;
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
