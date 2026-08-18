import { LinqAPIV3 } from "@linqapp/sdk";
import { Message, NotImplementedError, parseMarkdown } from "chat";
import type { Attachment, LinkPreview } from "chat";

import { isRecord } from "./guards.js";

type LinqMessageSendResponse = Awaited<ReturnType<LinqAPIV3["chats"]["messages"]["send"]>>;
type LinqRetrievedMessage = LinqAPIV3.Message;
export type LinqRawMessage =
  | LinqAPIV3.UnwrapWebhookEvent["data"]
  | LinqMessageSendResponse
  | LinqRetrievedMessage;
type LinqMessageEvent = LinqAPIV3.MessageEventV2;
type LinqMessagePart =
  | LinqMessageEvent["parts"][number]
  | LinqMessageSendResponse["message"]["parts"][number]
  | NonNullable<LinqRetrievedMessage["parts"]>[number];
type LinqMediaMessagePart = Extract<LinqMessagePart, { type: "media" }> & {
  width?: number;
  height?: number;
  width_px?: number;
  height_px?: number;
};

type LinqThreadId = {
  chatId: string;
  isGroup?: boolean;
};

export function parseLinqMessage(
  raw: LinqRawMessage,
  encodeThreadId: (platformData: LinqThreadId) => string,
): Message<LinqRawMessage> {
  const message = normalizeMessage(raw);
  const attachments = message.parts.flatMap((part): Attachment[] => {
    if (part.type !== "media") {
      return [];
    }

    return [toAttachment(part)];
  });
  const text = messageText(message.parts, attachments);
  const links = messageLinks(message.parts);

  const isMe = message.isMe;
  const senderId = message.sender?.id || message.sender?.handle || "unknown";
  const senderName = message.sender?.handle || message.sender?.id || "unknown";

  return new Message({
    id: message.id,
    threadId: encodeThreadId({ chatId: message.chatId, isGroup: message.isGroup }),
    text,
    formatted: parseMarkdown(text),
    raw,
    author: {
      userId: senderId,
      userName: senderName,
      fullName: senderName,
      isBot: isMe,
      isMe,
    },
    metadata: {
      dateSent: dateFrom(message.sentAt),
      edited: message.edited,
      editedAt: message.editedAt ? dateFrom(message.editedAt) : undefined,
    },
    attachments,
    links,
  });
}

export function isMessageReceivedWebhookEvent(
  event: LinqAPIV3.UnwrapWebhookEvent,
): event is LinqAPIV3.Webhooks.MessageReceivedWebhookEvent {
  return event.event_type === "message.received";
}

export function isReactionWebhookEvent(
  event: LinqAPIV3.UnwrapWebhookEvent,
): event is
  | LinqAPIV3.Webhooks.ReactionAddedWebhookEvent
  | LinqAPIV3.Webhooks.ReactionRemovedWebhookEvent {
  return event.event_type === "reaction.added" || event.event_type === "reaction.removed";
}

function normalizeMessage(value: LinqRawMessage): {
  id: string;
  chatId: string;
  isGroup?: boolean;
  parts: LinqMessagePart[];
  isMe: boolean;
  sender: LinqAPIV3.ChatHandle | null | undefined;
  sentAt: string | null | undefined;
  edited: boolean;
  editedAt?: string | null;
} {
  if (isMessageEvent(value)) {
    return {
      id: value.id,
      chatId: value.chat.id,
      isGroup: value.chat.is_group ?? undefined,
      parts: value.parts,
      isMe: value.direction === "outbound" || value.sender_handle.is_me === true,
      sender: value.sender_handle,
      sentAt: value.sent_at,
      edited: false,
    };
  }

  if (isMessageSendResponse(value)) {
    return {
      id: value.message.id,
      chatId: value.chat_id,
      isGroup: undefined,
      parts: value.message.parts,
      isMe: true,
      sender: value.message.from_handle,
      sentAt: value.message.sent_at || value.message.created_at,
      edited: false,
    };
  }

  if (isRetrievedMessage(value)) {
    const edited = value.updated_at !== value.created_at;

    return {
      id: value.id,
      chatId: value.chat_id,
      isGroup: undefined,
      parts: value.parts ?? [],
      isMe: value.is_from_me || value.from_handle?.is_me === true,
      sender: value.from_handle,
      sentAt: value.sent_at || value.created_at,
      edited,
      editedAt: edited ? value.updated_at : undefined,
    };
  }

  throw new NotImplementedError("parseMessage only supports Linq message payloads");
}

function isMessageEvent(value: LinqRawMessage): value is LinqMessageEvent {
  return isRecord(value) && "chat" in value && "direction" in value && "sender_handle" in value;
}

function isMessageSendResponse(value: LinqRawMessage): value is LinqMessageSendResponse {
  return isRecord(value) && "chat_id" in value && "message" in value && isRecord(value.message);
}

function isRetrievedMessage(value: LinqRawMessage): value is LinqRetrievedMessage {
  return isRecord(value) && "chat_id" in value && "is_from_me" in value && "created_at" in value;
}

function dateFrom(value: string | null | undefined): Date {
  if (value) {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
}

function messageText(parts: LinqMessagePart[], attachments: Attachment[]): string {
  const textParts = parts.flatMap((part) => {
    if ((part.type === "text" || part.type === "link") && typeof part.value === "string") {
      return [part.value];
    }

    return [];
  });
  const attachmentSummaries = attachments.map((attachment) => {
    const label = attachment.name || attachment.mimeType || attachment.type;

    return `[${attachment.type} attachment: ${label}]`;
  });

  return [...textParts, ...attachmentSummaries].join("\n").trim();
}

function messageLinks(parts: LinqMessagePart[]): LinkPreview[] {
  const urls = new Set<string>();

  for (const part of parts) {
    if (part.type === "link") {
      urls.add(part.value);
      continue;
    }

    if (part.type === "text") {
      for (const url of urlsFromText(part.value)) {
        urls.add(url);
      }
    }
  }

  return [...urls].map((url) => ({ url }));
}

function toAttachment(part: LinqMediaMessagePart): Attachment {
  return {
    type: attachmentType(part.mime_type),
    url: part.url,
    name: part.filename,
    mimeType: part.mime_type,
    size: part.size_bytes,
    width: part.width ?? part.width_px,
    height: part.height ?? part.height_px,
    // Linq media URLs are permanent (cdn.linqapp.com), so the URL is enough to
    // rebuild fetchData after the message is serialized to the queue and back.
    fetchMetadata: { url: part.url },
    fetchData: async () => {
      const response = await fetch(part.url);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Linq attachment ${part.id || part.url}: ${response.status}`,
        );
      }

      return Buffer.from(await response.arrayBuffer());
    },
  };
}

function attachmentType(mimeType: string): Attachment["type"] {
  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  if (mimeType.startsWith("audio/")) {
    return "audio";
  }

  return "file";
}

function urlsFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()]+/gi) ?? [];

  return matches.map((url) => url.replace(/[.,!?;:]+$/g, ""));
}
