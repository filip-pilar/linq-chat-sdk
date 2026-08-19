import { randomUUID } from "node:crypto";

import { LinqAPIV3 } from "@linqapp/sdk";

export const LINQ_SMOKE_EVENTS = [
  "message.received",
  "message.sent",
] as const satisfies readonly LinqAPIV3.WebhookEventType[];

export interface LinqSmokeClientConfig {
  apiKey: string;
  baseURL?: string;
}

export interface ExactLineTextInput {
  from: string;
  text: string;
  to: string;
}

export interface ExactLineTextResult {
  chatId: string;
  from: string;
  messageId: string;
  service: LinqAPIV3.ServiceType;
}

export function createLinqSmokeClient(config: LinqSmokeClientConfig): LinqAPIV3 {
  return new LinqAPIV3(config);
}

export async function sendExactLineText(
  client: LinqAPIV3,
  input: ExactLineTextInput,
): Promise<ExactLineTextResult> {
  const response = await client.chats.create({
    from: input.from,
    to: [input.to],
    message: {
      idempotency_key: randomUUID(),
      parts: [{ type: "text", value: input.text }],
    },
  });

  const ownerHandles = response.chat.handles.filter((handle) => handle.is_me === true);
  const recipientHandles = response.chat.handles.filter((handle) => handle.is_me !== true);
  const owner = ownerHandles[0];
  const exactLine = ownerHandles.length === 1 && owner?.handle === input.from;
  const exactRecipient =
    !response.chat.is_group &&
    recipientHandles.length === 1 &&
    recipientHandles[0]?.handle === input.to;

  if (!owner || !exactLine || !exactRecipient) {
    throw new Error("Linq exact-line smoke postcondition failed");
  }

  return {
    chatId: response.chat.id,
    from: owner.handle,
    messageId: response.chat.message.id,
    service: response.chat.service,
  };
}

export function createExactLineSmokeSubscription(
  client: LinqAPIV3,
  targetUrl: string,
  from: string,
) {
  return client.webhookSubscriptions.create({
    target_url: targetUrl,
    subscribed_events: [...LINQ_SMOKE_EVENTS],
    phone_numbers: [from],
  });
}

export function deleteSmokeSubscription(client: LinqAPIV3, subscriptionId: string): Promise<void> {
  return client.webhookSubscriptions.delete(subscriptionId);
}
