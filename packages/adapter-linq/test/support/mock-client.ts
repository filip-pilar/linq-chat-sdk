import type { LinqAPIV3 } from "@linqapp/sdk";
import type { ChatInstance } from "chat";
import { vi } from "vitest";

/**
 * Test doubles typed against the SDK.
 *
 * The suite injected `apiClient` through `as unknown as`, which detaches the
 * double from the real API: a fake response could drift from the SDK's shape
 * and every test would still pass. Typing the doubles makes the fakes contract
 * assertions — an SDK upgrade that reshapes a request or a response fails
 * typecheck here rather than in production.
 */

type SendMessage = LinqAPIV3["chats"]["messages"]["send"];
type CreateMessage = LinqAPIV3["messages"]["create"];
type RetrieveChat = LinqAPIV3["chats"]["retrieve"];

/** A `chats.messages.send` double whose resolved value must match the SDK. */
export function mockSend(response: Awaited<ReturnType<SendMessage>>) {
  return vi.fn().mockResolvedValue(response) as unknown as SendMessage & {
    mock: { calls: unknown[][] };
  };
}

/** A `messages.create` double whose resolved value must match the SDK. */
export function mockCreate(response: Awaited<ReturnType<CreateMessage>>) {
  return vi.fn().mockResolvedValue(response) as unknown as CreateMessage & {
    mock: { calls: unknown[][] };
  };
}

/** A `chats.retrieve` double whose resolved value must match the SDK. */
export function mockRetrieve(response: Awaited<ReturnType<RetrieveChat>>) {
  return vi.fn().mockResolvedValue(response) as unknown as RetrieveChat;
}

/**
 * Rejects the way the SDK does on an API error, so tests can assert that a
 * caller still sees `error.code` and can branch on it.
 */
export function mockApiError(status: number, code: number, message: string) {
  const error = Object.assign(new Error(message), {
    status,
    error: {
      status,
      code,
      message,
      doc_url: `https://docs.linqapp.com/error/codes/${code}/`,
    },
  });
  return vi.fn().mockRejectedValue(error);
}

/** Installs a partial API client on an adapter without erasing the adapter's type. */
export function withApiClient<T>(adapter: T, client: unknown): T {
  (adapter as { apiClient: unknown }).apiClient = client;
  return adapter;
}

/** Installs a Chat SDK stand-in on an adapter. */
export function withChat<T>(adapter: T, chat: Partial<ChatInstance>): T {
  (adapter as { chat: unknown }).chat = chat;
  return adapter;
}
