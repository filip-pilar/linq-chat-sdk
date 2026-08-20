import type { LinqAPIV3 } from "@linqapp/sdk";
import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";
import { WEBHOOK_EVENT_COVERAGE, handledWebhookEvents } from "../src/webhook-events";
import { withChat } from "./support/mock-client";

const SIGNING_SECRET = "whsec_c2hoaC10aGlzLWlzLWEtdGVzdC1zZWNyZXQtdmFsdWU=";
const API_KEY = "test_linq_api_key";

/**
 * The ledger is only useful if it describes the code. These tests keep the two
 * honest: an event marked "handled" must actually reach the Chat SDK, and one
 * marked ignored must not.
 */
describe("webhook event coverage", () => {
  it("records a disposition for every event the SDK can send", () => {
    // The Record<WebhookEventType, …> type enforces this at compile time; this
    // asserts the runtime object was not widened or partially built.
    expect(Object.keys(WEBHOOK_EVENT_COVERAGE).length).toBeGreaterThanOrEqual(44);
  });

  it("gives every ignored event a stated reason", () => {
    for (const [event, disposition] of Object.entries(WEBHOOK_EVENT_COVERAGE)) {
      if (disposition === "handled") continue;
      expect(disposition.ignored, `${event} is ignored without a reason`).toMatch(/\S/);
    }
  });

  it("dispatches every event it claims to handle", async () => {
    for (const event of handledWebhookEvents()) {
      const { adapter, processMessage, processReaction, onDeliveryStatus } =
        createInstrumentedAdapter();

      const response = await adapter.handleWebhook(signed(payloadFor(event)));
      await tick();

      expect(response.status, `${event} should be accepted`).toBe(200);
      // "Handled" means the adapter acts on it, whether that lands on the Chat
      // SDK or on an adapter-owned surface such as delivery status.
      const dispatched =
        processMessage.mock.calls.length +
        processReaction.mock.calls.length +
        onDeliveryStatus.mock.calls.length;
      expect(dispatched, `${event} claims "handled" but reached nothing`).toBeGreaterThan(0);
    }
  });

  it("accepts but does not dispatch an ignored event", async () => {
    const { adapter, processMessage, processReaction, onDeliveryStatus } =
      createInstrumentedAdapter();

    // chat.created is a real delivery Linq sends. Acknowledging it is
    // required; acting on it is not yet implemented.
    const response = await adapter.handleWebhook(signed(payloadFor("chat.created")));
    await tick();

    expect(response.status).toBe(200);
    expect(processMessage).not.toHaveBeenCalled();
    expect(processReaction).not.toHaveBeenCalled();
    expect(onDeliveryStatus).not.toHaveBeenCalled();
  });
});

function createInstrumentedAdapter() {
  const adapter = createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
  const processMessage = vi.fn();
  const processReaction = vi.fn();
  const onDeliveryStatus = vi.fn();
  withChat(adapter, { processMessage, processReaction } as never);
  adapter.onDeliveryStatus(onDeliveryStatus);
  return { adapter, processMessage, processReaction, onDeliveryStatus };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function signed(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const messageId = "msg_coverage";
  const timestamp = new Date();
  const signature = new Webhook(SIGNING_SECRET).sign(messageId, timestamp, body);

  return new Request("https://example.com/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
      "webhook-signature": signature,
    },
    body,
  });
}

function payloadFor(eventType: LinqAPIV3.WebhookEventType) {
  const envelope = {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: eventType,
    event_id: `coverage-${eventType}`,
    created_at: "2026-08-20T00:00:00.000Z",
    trace_id: "coverage",
    partner_id: "coverage",
  };
  const chatId = "9c1f0a2e-3d4b-4c5d-8e9f-0a1b2c3d4e5f";

  if (eventType === "reaction.added" || eventType === "reaction.removed") {
    return {
      ...envelope,
      data: {
        chat_id: chatId,
        message_id: "0f2b6f77-4a0e-4a3e-9d5f-8f2f6b8e1c11",
        reaction_type: "like",
        sender_handle: { handle: "+12025550147", service: "iMessage" },
      },
    };
  }

  return {
    ...envelope,
    data: {
      id: "0f2b6f77-4a0e-4a3e-9d5f-8f2f6b8e1c11",
      direction: "inbound",
      chat: { id: chatId, is_group: false },
      sender_handle: { handle: "+12025550147", service: "iMessage" },
      service: "iMessage",
      parts: [{ type: "text", value: "coverage" }],
      sent_at: "2026-08-20T00:00:00.000Z",
    },
  };
}
