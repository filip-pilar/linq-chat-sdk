import type { LinqAPIV3 } from "@linqapp/sdk";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";

import { createLinqAdapter } from "../src/adapter";

// Standard Webhooks secrets are base64. Linq issues them `whsec_`-prefixed.
const SIGNING_SECRET = "whsec_c2hoaC10aGlzLWlzLWEtdGVzdC1zZWNyZXQtdmFsdWU=";
const API_KEY = "test_linq_api_key";

describe("Standard Webhooks verification", () => {
  it("accepts a delivery signed with Standard Webhooks headers", async () => {
    const adapter = createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
    const response = await adapter.handleWebhook(signedRequest(messageReceivedPayload()));

    expect(response.status).toBe(200);
  });

  it("rejects a delivery whose signature does not match the body", async () => {
    const adapter = createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
    const request = signedRequest(messageReceivedPayload(), {
      signature: "v1,bm90LWEtcmVhbC1zaWduYXR1cmU=",
    });
    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(401);
  });

  it("rejects a delivery signed for a different message id", async () => {
    const adapter = createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
    const body = JSON.stringify(messageReceivedPayload());
    const timestamp = new Date();
    // Sign for one id, then present the delivery under another.
    const signature = new Webhook(SIGNING_SECRET).sign("msg_signed", timestamp, body);
    const request = new Request("https://example.com/webhooks/linq", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": "msg_presented",
        "webhook-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
        "webhook-signature": signature,
      },
      body,
    });
    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(401);
  });

  it("rejects a delivery with no signature headers at all", async () => {
    const adapter = createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
    const request = new Request("https://example.com/webhooks/linq", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messageReceivedPayload()),
    });
    const response = await adapter.handleWebhook(request);

    expect(response.status).toBe(401);
  });

  it("rejects a delivery signed outside the replay window", async () => {
    const adapter = createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const response = await adapter.handleWebhook(
      signedRequest(messageReceivedPayload(), { timestamp: stale }),
    );

    expect(response.status).toBe(401);
  });
});

function signedRequest(
  payload: unknown,
  overrides: { signature?: string; timestamp?: Date; messageId?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  const messageId = overrides.messageId ?? "msg_2abc";
  const timestamp = overrides.timestamp ?? new Date();
  const signature =
    overrides.signature ?? new Webhook(SIGNING_SECRET).sign(messageId, timestamp, body);

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

function messageReceivedPayload(): LinqAPIV3.MessageReceivedWebhookEvent {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: "ff654877-df18-4384-b3aa-928212533477",
    created_at: "2026-05-08T16:21:12.793119775Z",
    trace_id: "5619088b713532654fd0e6023b8c98e1",
    partner_id: "7ac8224b-c41a-54fb-96ed-e28a94f97ff6",
    data: {
      id: "0f2b6f77-4a0e-4a3e-9d5f-8f2f6b8e1c11",
      direction: "inbound",
      chat: { id: "9c1f0a2e-3d4b-4c5d-8e9f-0a1b2c3d4e5f", is_group: false },
      sender_handle: { handle: "+12025550147", service: "iMessage" },
      service: "iMessage",
      parts: [{ type: "text", value: "hello" }],
      sent_at: "2026-05-08T16:21:12.000Z",
    },
  };
}
