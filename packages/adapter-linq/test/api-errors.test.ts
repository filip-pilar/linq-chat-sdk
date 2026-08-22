import { describe, expect, it } from "vitest";

import { createLinqAdapter } from "../src/adapter";
import { mockApiError, withApiClient } from "./support/mock-client";

const SIGNING_SECRET = "whsec_c2hoaC10aGlzLWlzLWEtdGVzdC1zZWNyZXQtdmFsdWU=";
const API_KEY = "test_linq_api_key";
const CHAT_THREAD = "linq:3caaf1a0-ef9f-46e0-8c22-31e82c8514dc";

/**
 * Linq's documented failure modes. None of these are visible to typecheck: the
 * call compiles, the server refuses at runtime. Each is a case a caller needs
 * to branch on, so these pin that the error reaches them with `code` intact
 * rather than being swallowed or reshaped.
 */
describe("Linq API errors reach the caller", () => {
  it("surfaces 403 / 2008 when the line has not been messaged first", async () => {
    const adapter = withApiClient(createTestAdapter(), {
      chats: {
        messages: {
          send: mockApiError(403, 2008, "Recipient not allowed"),
        },
      },
    });

    await expect(adapter.postMessage(CHAT_THREAD, "hello")).rejects.toMatchObject({
      status: 403,
      error: { code: 2008 },
    });
  });

  it("surfaces 409 / 2015 when the account has no eligible sending line", async () => {
    const adapter = withApiClient(createTestAdapter(), {
      messages: {
        create: mockApiError(409, 2015, "no eligible sending line available"),
      },
    });

    const pending = await adapter.openDM("+12025550147");

    await expect(adapter.postMessage(pending, "hello")).rejects.toMatchObject({
      status: 409,
      error: { code: 2015 },
    });
  });

  it("surfaces 429 so a caller can honor Retry-After", async () => {
    const adapter = withApiClient(createTestAdapter(), {
      chats: {
        messages: {
          send: mockApiError(429, 1015, "Rate limit exceeded"),
        },
      },
    });

    await expect(adapter.postMessage(CHAT_THREAD, "hello")).rejects.toMatchObject({
      status: 429,
    });
  });

  it("does not retry a failed send behind the caller's back", async () => {
    const send = mockApiError(403, 2008, "Recipient not allowed");
    const adapter = withApiClient(createTestAdapter(), {
      chats: { messages: { send } },
    });

    await expect(adapter.postMessage(CHAT_THREAD, "hi")).rejects.toThrow();

    // A silent retry against an opted-out or disallowed recipient is a
    // compliance problem, not a resilience feature.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the error's doc_url, which nests under error rather than the top level", async () => {
    const adapter = withApiClient(createTestAdapter(), {
      chats: {
        messages: {
          send: mockApiError(403, 2024, "Recipient has opted out"),
        },
      },
    });

    await expect(adapter.postMessage(CHAT_THREAD, "hello")).rejects.toMatchObject({
      error: { code: 2024, doc_url: expect.stringContaining("2024") },
    });
  });
});

function createTestAdapter() {
  return createLinqAdapter({ apiKey: API_KEY, signingSecret: SIGNING_SECRET });
}
