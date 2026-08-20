import { LinqAPIV3 } from "@linqapp/sdk";
import { Message, NotImplementedError, paragraph, root, text as textNode } from "chat";
import type { Attachment, FormattedContent, LinkPreview } from "chat";

import { isRecord } from "./guards.js";
import { createLinqAttachmentFetcher } from "./inbound-media.js";
import type {
  LinqMessageReceivedWebhookData,
  LinqMessageReceivedWebhookEvent,
  LinqReactionWebhookEvent,
  LinqWebhookEvent,
} from "./webhook.js";

type LinqMessageSendResponse = Awaited<ReturnType<LinqAPIV3["chats"]["messages"]["send"]>>;
type LinqRetrievedMessage = LinqAPIV3.Message;
export type LinqRawMessage =
  | LinqMessageReceivedWebhookData
  | LinqMessageSendResponse
  | LinqRetrievedMessage;
type LinqMessageEvent = LinqMessageReceivedWebhookData;
type LinqMessagePart = Readonly<Record<string, unknown>>;

type LinqThreadId = {
  chatId: string;
  isGroup?: boolean;
};

export function parseLinqMessage(
  raw: LinqRawMessage,
  encodeThreadId: (platformData: LinqThreadId) => string,
  attachmentLookup?: LinqAPIV3["attachments"],
): Message<LinqRawMessage> {
  const message = normalizeMessage(raw);
  const attachments = message.parts.flatMap((part): Attachment[] => {
    if (part.type !== "media" || !isUsableMediaPart(part)) {
      return [];
    }

    return [toAttachment(part, attachmentLookup)];
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
    // Linq text parts are plain text. Formatting intent remains in the typed/raw
    // decoration observations instead of interpreting literal Markdown markers.
    formatted: plainFormatted(text),
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

function plainFormatted(value: string): FormattedContent {
  return root([paragraph([textNode(value)])]);
}

export function isMessageReceivedWebhookEvent(
  event: LinqWebhookEvent,
): event is LinqMessageReceivedWebhookEvent {
  return event.event_type === "message.received";
}

export function isReactionWebhookEvent(event: LinqWebhookEvent): event is LinqReactionWebhookEvent {
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
    if (!isRecord(value.chat) || typeof value.chat.id !== "string") {
      throw new NotImplementedError("Linq message event is missing canonical chat identity");
    }

    return {
      id: value.id,
      chatId: value.chat.id,
      isGroup: value.chat.is_group ?? undefined,
      parts: validParts(value.parts),
      isMe:
        value.direction === "outbound" ||
        (isRecord(value.sender_handle) && value.sender_handle.is_me === true),
      sender: isRecord(value.sender_handle)
        ? (value.sender_handle as unknown as LinqAPIV3.ChatHandle)
        : null,
      sentAt: value.sent_at,
      edited: false,
    };
  }

  if (isMessageSendResponse(value)) {
    return {
      id: value.message.id,
      chatId: value.chat_id,
      isGroup: undefined,
      parts: validParts(value.message.parts),
      isMe: true,
      sender: value.message.from_handle,
      sentAt: value.message.sent_at || value.message.created_at,
      edited: false,
    };
  }

  if (isRetrievedMessage(value)) {
    return {
      id: value.id,
      chatId: value.chat_id,
      isGroup: undefined,
      parts: validParts(value.parts),
      isMe: value.is_from_me || value.from_handle?.is_me === true,
      sender: value.from_handle,
      sentAt: value.sent_at || value.created_at,
      // `updated_at` also changes for delivery state. Only message.edited webhooks
      // confirm an edit, and the retrieved Message schema exposes no edit timestamp.
      edited: false,
    };
  }

  throw new NotImplementedError("parseMessage only supports Linq message payloads");
}

function isMessageEvent(value: LinqRawMessage): value is LinqMessageEvent {
  return isRecord(value) && "chat" in value && "direction" in value && "sender_handle" in value;
}

function validParts(value: unknown): LinqMessagePart[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (part): part is LinqMessagePart => isRecord(part) && typeof part.type === "string",
  );
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
    if (
      (part.type === "text" || part.type === "link" || part.type === "app_clip") &&
      typeof part.value === "string"
    ) {
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
    if (part.type === "link" || part.type === "app_clip") {
      if (typeof part.value === "string") urls.add(part.value);
      continue;
    }

    if (part.type === "text" && typeof part.value === "string") {
      for (const url of urlsFromText(part.value)) {
        urls.add(url);
      }
    }
  }

  return [...urls].map((url) => ({ url }));
}

function toAttachment(
  part: LinqMessagePart,
  attachmentLookup?: LinqAPIV3["attachments"],
): Attachment {
  const reference = {
    attachmentId: part.id as string,
    filename: part.filename as string,
    mimeType: part.mime_type as string,
    sizeBytes: part.size_bytes as number,
  };

  return {
    type: attachmentType(part.mime_type as string),
    name: part.filename as string,
    mimeType: part.mime_type as string,
    size: part.size_bytes as number,
    width: finiteNumber(part.width) ?? finiteNumber(part.width_px),
    height: finiteNumber(part.height) ?? finiteNumber(part.height_px),
    // Persist only the stable provider reference. Webhook media URLs expire.
    fetchMetadata: { attachmentId: part.id as string },
    fetchData: attachmentLookup
      ? createLinqAttachmentFetcher(attachmentLookup, reference)
      : undefined,
  };
}

function isUsableMediaPart(part: LinqMessagePart): boolean {
  return (
    typeof part.id === "string" &&
    typeof part.filename === "string" &&
    typeof part.mime_type === "string" &&
    typeof part.size_bytes === "number" &&
    Number.isFinite(part.size_bytes) &&
    part.size_bytes >= 0
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
