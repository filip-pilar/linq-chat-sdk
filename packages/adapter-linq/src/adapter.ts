import { LinqAPIV3 } from "@linqapp/sdk";
import { ConsoleLogger, Message, NotImplementedError, stringifyMarkdown } from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StreamChunk,
  ThreadInfo,
  WebhookOptions,
} from "chat";

import { cardHasInteractiveActions, collectCardImageUrls, extractCardElement } from "./cards.js";
import { LinqFormatConverter } from "./format-converter.js";
import { isRecord } from "./guards.js";
import { createLinqAttachmentFetcher } from "./inbound-media.js";
import {
  isMessageReceivedWebhookEvent,
  isReactionWebhookEvent,
  parseLinqMessage,
  type LinqRawMessage,
} from "./message-parser.js";
import { buildLinqMediaParts } from "./outbound-media.js";
import { fromLinqReaction, toLinqReaction } from "./reactions.js";
import { verifyLinqWebhookRequest } from "./verification.js";

type LinqOutboundPart =
  | { type: "text"; value: string }
  | { type: "media"; url: string }
  | { type: "media"; attachment_id: string };

type LinqThreadId = {
  chatId: string;
  isGroup?: boolean;
};

export interface LinqAdapterConfig {
  apiKey: string;
  baseURL?: string;
  signingSecret: string;
}

class LinqAdapter implements Adapter<LinqThreadId, LinqRawMessage> {
  readonly name: string = "linq";
  readonly userName: string = "linq";
  readonly persistMessageHistory = true;
  private readonly apiClient: LinqAPIV3;
  private readonly converter = new LinqFormatConverter();
  private readonly signingSecret: string;

  private chat: ChatInstance | null = null;
  private logger: Logger;
  // chatId -> isGroup, learned from webhooks, fetchThread, and legacy thread IDs.
  private readonly chatKinds = new Map<string, boolean>();

  constructor(config: LinqAdapterConfig) {
    this.apiClient = new LinqAPIV3({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.signingSecret = config.signingSecret;
    this.logger = new ConsoleLogger();
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger("linq");
  }

  // Thread ID
  //
  // The encoded form is always `linq:{chatId}` so the same Linq chat maps to the
  // same Chat SDK thread no matter which path (webhook, fetch, send) produced it.
  // Group/DM identity lives in `chatKinds` instead of the thread ID.
  encodeThreadId(platformData: LinqThreadId): string {
    if (platformData.isGroup !== undefined) {
      this.chatKinds.set(platformData.chatId, platformData.isGroup);
    }

    return `linq:${platformData.chatId}`;
  }

  decodeThreadId(threadId: string): LinqThreadId {
    const [adapterName, chatId, kind] = threadId.split(":");

    if (adapterName !== "linq" || !chatId) {
      throw new Error(`Invalid Linq thread ID: ${threadId}`);
    }

    // Older adapter versions encoded group/dm into the thread ID. Keep decoding
    // those so persisted thread IDs survive the format change.
    if (kind === "group" || kind === "dm") {
      const isGroup = kind === "group";
      this.chatKinds.set(chatId, isGroup);

      return { chatId, isGroup };
    }

    if (kind !== undefined) {
      throw new Error(`Invalid Linq thread ID: ${threadId}`);
    }

    return { chatId, isGroup: this.chatKinds.get(chatId) };
  }

  // Messages
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<LinqRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const page = await this.apiClient.chats.messages.list(chatId, {
      cursor: options?.cursor,
      limit: options?.limit,
    });

    return {
      messages: page.messages
        .map((message) => this.parseMessage(message))
        .sort(function compareMessages(
          left: Message<LinqRawMessage>,
          right: Message<LinqRawMessage>,
        ): number {
          return left.metadata.dateSent.getTime() - right.metadata.dateSent.getTime();
        }),
      nextCursor: page.next_cursor || undefined,
    };
  }

  async fetchMessage(
    _threadId: string,
    messageId: string,
  ): Promise<Message<LinqRawMessage> | null> {
    try {
      const message = await this.apiClient.messages.retrieve(messageId);

      return this.parseMessage(message);
    } catch (error) {
      if (isRecord(error) && error.status === 404) {
        return null;
      }

      throw error;
    }
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const text = this.converter.renderPostable(message).trim();
    const mediaParts = await buildLinqMediaParts(this.apiClient, message);

    const parts: LinqOutboundPart[] = [];

    // Text leads so the message reads as [text, media, ...]; Linq disallows
    // consecutive text parts but is fine with a single text part before media.
    if (text) {
      parts.push({ type: "text", value: text });
    }

    // Card images become real media parts; the rest of the card is already
    // flattened into the fallback text above.
    const card = extractCardElement(message);

    if (card) {
      // Feedback instead of silence: the card still sends, but its buttons and
      // selects are text labels — the poster's onAction() handlers can't fire.
      if (cardHasInteractiveActions(card)) {
        this.logger.warn(
          "Card buttons/selects were flattened to text — onAction() handlers never fire over iMessage/SMS. " +
            "Use LinkButton/CardLink URLs or handle plain-text replies instead.",
        );
      }

      for (const url of collectCardImageUrls(card)) {
        parts.push({ type: "media", url });
      }
    }

    parts.push(...mediaParts);

    if (parts.length === 0) {
      throw new Error("Linq message must include text or media.");
    }

    const response = await this.apiClient.chats.messages.send(chatId, {
      message: { parts },
    });

    return {
      id: response.message.id,
      threadId: this.encodeThreadId({ chatId: response.chat_id || chatId }),
      raw: response,
    };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const text = this.converter.renderPostable(message).trim();

    if (!text) {
      throw new Error("Linq message text cannot be empty.");
    }

    const response = await this.apiClient.messages.update(messageId, {
      text,
      part_index: 0,
    });

    return {
      id: response.id,
      threadId: this.encodeThreadId({ chatId: response.chat_id || chatId }),
      raw: response,
    };
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError("deleteMessage is not implemented");
  }

  // Reactions
  async addReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.apiClient.messages.addReaction(messageId, {
      operation: "add",
      ...toLinqReaction(emoji),
    });
  }

  async removeReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.apiClient.messages.addReaction(messageId, {
      operation: "remove",
      ...toLinqReaction(emoji),
    });
  }

  // Threads
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId);
    const chat = await this.apiClient.chats.retrieve(chatId);

    return {
      id: this.encodeThreadId({ chatId: chat.id, isGroup: chat.is_group }),
      channelId: this.encodeThreadId({ chatId: chat.id, isGroup: chat.is_group }),
      channelName: chat.display_name ?? undefined,
      isDM: !chat.is_group,
      metadata: {
        chat,
      },
    };
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    const { chatId, isGroup } = this.decodeThreadId(threadId);

    if (isGroup === true) {
      return;
    }

    try {
      await this.apiClient.chats.typing.start(chatId);
    } catch (error) {
      if (isRecord(error) && error.status === 403) {
        return;
      }

      throw error;
    }
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<LinqRawMessage>> {
    let text = "";

    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        text += chunk;
        continue;
      }

      if (chunk.type === "markdown_text") {
        text += chunk.text;
      }
    }

    return this.postMessage(threadId, text.trim() ? { markdown: text } : " ");
  }

  // handle webhook
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    type LinqWebhookEvent = LinqAPIV3.EventsWebhookEvent;

    const verification = await verifyLinqWebhookRequest(request, this.signingSecret);

    if (!verification.ok) {
      return verification.response;
    }

    let event: LinqWebhookEvent;

    try {
      event = JSON.parse(new TextDecoder().decode(verification.rawBody)) as LinqWebhookEvent;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (this.chat && isMessageReceivedWebhookEvent(event) && event.data.direction === "inbound") {
      const chatId = event.data.chat.id;
      const isGroup = event.data.chat.is_group ?? undefined;

      // isDM() only trusts known chats, so resolve group/DM identity before
      // dispatching when the webhook does not carry it.
      if (isGroup === undefined && !this.chatKinds.has(chatId)) {
        try {
          const chat = await this.apiClient.chats.retrieve(chatId);

          this.chatKinds.set(chatId, chat.is_group);
        } catch (error) {
          this.logger.warn(`Failed to resolve Linq chat kind for ${chatId}`, { error });
        }
      }

      const threadId = this.encodeThreadId({ chatId, isGroup });

      const factory = async (): Promise<Message<unknown>> => {
        const msg = this.parseMessage(event.data);

        return msg;
      };

      this.chat.processMessage(this, threadId, factory, options);
    } else if (this.chat && isReactionWebhookEvent(event)) {
      this.processReactionWebhook(this.chat, event, options);
    }

    return new Response("OK", { status: 200 });
  }

  private processReactionWebhook(
    chat: ChatInstance,
    event:
      | LinqAPIV3.Webhooks.ReactionAddedWebhookEvent
      | LinqAPIV3.Webhooks.ReactionRemovedWebhookEvent,
    options?: WebhookOptions,
  ): void {
    const { chat_id: chatId, message_id: messageId } = event.data;

    if (!chatId || !messageId) {
      this.logger.debug(`Ignoring Linq ${event.event_type} webhook without chat/message ID`);

      return;
    }

    const reaction = fromLinqReaction(event.data);

    if (!reaction) {
      this.logger.debug(
        `Ignoring Linq ${event.event_type} webhook with unsupported reaction type ${event.data.reaction_type}`,
      );

      return;
    }

    const handle = event.data.from_handle;
    const isMe = event.data.is_from_me || handle?.is_me === true;
    const senderId = handle?.id || handle?.handle || event.data.from || "unknown";
    const senderName = handle?.handle || event.data.from || senderId;

    chat.processReaction(
      {
        adapter: this,
        added: event.event_type === "reaction.added",
        emoji: reaction.emoji,
        rawEmoji: reaction.rawEmoji,
        messageId,
        threadId: this.encodeThreadId({ chatId }),
        raw: event,
        user: {
          userId: senderId,
          userName: senderName,
          fullName: senderName,
          isBot: isMe,
          isMe,
        },
      },
      options,
    );
  }

  parseMessage(raw: LinqRawMessage): Message<LinqRawMessage> {
    return parseLinqMessage(
      raw,
      (platformData) => this.encodeThreadId(platformData),
      this.apiClient.attachments,
    );
  }

  // Rebuild fetchData from the stable provider attachment ID after queue
  // serialization. A fresh CDN URL is resolved only when bytes are requested.
  rehydrateAttachment(attachment: Attachment): Attachment {
    const attachmentId = attachment.fetchMetadata?.attachmentId;

    if (
      !attachmentId ||
      !attachment.name ||
      !attachment.mimeType ||
      attachment.size === undefined
    ) {
      return attachment;
    }

    return {
      ...attachment,
      fetchData: createLinqAttachmentFetcher(this.apiClient.attachments, {
        attachmentId,
        filename: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.size,
      }),
    };
  }

  // Random
  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content).trim();
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    // Only report a DM when we have seen the chat and know it is not a group.
    // Webhooks always carry `is_group`, so this is warm before handlers run.
    return this.decodeThreadId(threadId).isGroup === false;
  }
}

export function createLinqAdapter(config: LinqAdapterConfig) {
  return new LinqAdapter(config);
}
