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
import {
  isMessageReceivedWebhookEvent,
  isReactionWebhookEvent,
  parseLinqMessage,
  type LinqRawMessage,
} from "./message-parser.js";
import { buildLinqMediaParts } from "./outbound-media.js";
import { fromLinqReaction, toLinqReaction } from "./reactions.js";
import {
  verifyLinqWebhookRequest,
  type LinqWebhookVerificationResult,
} from "./verification.js";

type LinqOutboundPart =
  | { type: "text"; value: string }
  | { type: "media"; url: string }
  | { type: "media"; attachment_id: string };

type LinqThreadId = {
  chatId: string;
  isGroup?: boolean;
  /** Target handle for a thread opened before its chat exists. See `openDM`. */
  pendingHandle?: string;
};

/** Credentials for Linq's outbound API and direct signed webhooks. */
export interface LinqCredentials {
  apiKey: string;
  /** Required only when direct Linq HMAC verification is in use. */
  signingSecret?: string;
}

/** Resolves credentials lazily, including from a managed credential store. */
export type LinqCredentialProvider = () => LinqCredentials | Promise<LinqCredentials>;

/**
 * Verifies a trusted, forwarded webhook. Throw (or return `false`) to reject
 * the request. It takes precedence over Linq's direct HMAC verification.
 */
export type LinqWebhookVerifier = (
  request: Request,
  rawBody: Uint8Array,
) => unknown | Promise<unknown>;

export interface LinqAdapterConfig {
  /** Direct API key. Use with `signingSecret`, or prefer lazy `credentials`. */
  apiKey?: string;
  baseURL?: string;
  /** Lazy credentials, for example from an externally managed credential store. */
  credentials?: LinqCredentialProvider;
  /** Direct webhook signing secret. Ignored when `webhookVerifier` is supplied. */
  signingSecret?: string;
  /** Trusted webhook verifier for managed webhook forwarding. */
  webhookVerifier?: LinqWebhookVerifier;
}

class LinqAdapter implements Adapter<LinqThreadId, LinqRawMessage> {
  readonly name: string = "linq";
  readonly userName: string = "linq";
  private apiClient: LinqAPIV3 | null;
  private readonly baseURL: string | undefined;
  private readonly converter = new LinqFormatConverter();
  private readonly credentials: LinqCredentialProvider | undefined;
  private readonly signingSecret: string | undefined;
  private readonly webhookVerifier: LinqWebhookVerifier | undefined;

  private chat: ChatInstance | null = null;
  private logger: Logger;
  // chatId -> isGroup, learned from webhooks, fetchThread, and legacy thread IDs.
  private readonly chatKinds = new Map<string, boolean>();

  constructor(config: LinqAdapterConfig) {
    if (!config.credentials && !config.apiKey) {
      throw new Error("Linq requires apiKey or a credentials provider.");
    }
    if (!config.webhookVerifier && !config.credentials && !config.signingSecret) {
      throw new Error("Linq requires signingSecret or a webhookVerifier.");
    }

    this.apiClient = config.apiKey
      ? new LinqAPIV3({ apiKey: config.apiKey, baseURL: config.baseURL })
      : null;
    this.baseURL = config.baseURL;
    this.credentials = config.credentials;
    this.signingSecret = config.signingSecret;
    this.webhookVerifier = config.webhookVerifier;
    this.logger = new ConsoleLogger();
  }

  private async getApiClient(): Promise<LinqAPIV3> {
    if (this.apiClient) return this.apiClient;

    const credentials = await this.credentials?.();
    if (!credentials?.apiKey) {
      throw new Error("Linq credentials did not provide an API key.");
    }

    return new LinqAPIV3({ apiKey: credentials.apiKey, baseURL: this.baseURL });
  }

  private async getSigningSecret(): Promise<string> {
    if (this.signingSecret) return this.signingSecret;

    const credentials = await this.credentials?.();
    if (!credentials?.signingSecret) {
      throw new Error("Linq credentials did not provide a webhook signing secret.");
    }

    return credentials.signingSecret;
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
    if (platformData.pendingHandle) {
      return `linq:pending:${platformData.pendingHandle}`;
    }

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

    // A thread opened with openDM() has no chat until its first message.
    // Linq cannot create an empty chat, so the target handle rides in the
    // thread ID and the chat is created on the first post.
    if (chatId === "pending") {
      const pendingHandle = threadId.slice("linq:pending:".length);

      if (!pendingHandle) {
        throw new Error(`Invalid Linq thread ID: ${threadId}`);
      }

      return { chatId: "", pendingHandle, isGroup: false };
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
    const chatId = this.requireChatId(threadId);
    const page = await (await this.getApiClient()).chats.messages.list(chatId, {
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
      const message = await (await this.getApiClient()).messages.retrieve(messageId);

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
    const { chatId, pendingHandle } = this.decodeThreadId(threadId);
    const text = this.converter.renderPostable(message).trim();
    const mediaParts = await buildLinqMediaParts(await this.getApiClient(), message);

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

    const client = await this.getApiClient();

    // A pending thread has no chat yet. `messages.create` lets Linq pick the
    // sending line and reuses an existing chat with the same recipients, so a
    // repeated first post lands in one conversation rather than forking it.
    if (pendingHandle) {
      const created = await client.messages.create({
        to: [pendingHandle],
        message: { parts },
      });

      return {
        id: created.message.id,
        threadId: this.encodeThreadId({ chatId: created.chat_id }),
        raw: created as LinqRawMessage,
      };
    }

    const response = await client.chats.messages.send(chatId, {
      message: { parts },
    });

    return {
      id: response.message.id,
      threadId: this.encodeThreadId({ chatId: response.chat_id || chatId }),
      raw: response,
    };
  }

  // Chats
  //
  // Linq has no empty-chat primitive: a chat is created by its first message.
  // openDM therefore returns a deterministic pending thread ID that carries the
  // target handle, and postMessage creates the chat when the first message is
  // sent. The ID is stable, so a caller can address someone it has never
  // messaged without a round trip.
  /**
   * Decodes a thread ID for an operation that needs an existing Linq chat.
   *
   * A thread from `openDM` has none until its first message, so anything other
   * than posting fails here with the remedy rather than a confusing API error.
   */
  private requireChatId(threadId: string): string {
    const { chatId, pendingHandle } = this.decodeThreadId(threadId);

    if (pendingHandle) {
      throw new Error(
        `Linq thread ${threadId} has no chat yet — send a message first to create it.`,
      );
    }

    return chatId;
  }

  async openDM(handle: string): Promise<string> {
    const pendingHandle = handle.trim();

    if (!pendingHandle) {
      throw new Error("Linq openDM requires a handle.");
    }

    return this.encodeThreadId({ chatId: "", pendingHandle });
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<LinqRawMessage>> {
    const chatId = this.requireChatId(threadId);
    const text = this.converter.renderPostable(message).trim();

    if (!text) {
      throw new Error("Linq message text cannot be empty.");
    }

    const response = await (await this.getApiClient()).messages.update(messageId, {
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
    await (await this.getApiClient()).messages.addReaction(messageId, {
      operation: "add",
      ...toLinqReaction(emoji),
    });
  }

  async removeReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await (await this.getApiClient()).messages.addReaction(messageId, {
      operation: "remove",
      ...toLinqReaction(emoji),
    });
  }

  // Threads
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const chatId = this.requireChatId(threadId);
    const chat = await (await this.getApiClient()).chats.retrieve(chatId);

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
    const chatId = this.requireChatId(threadId);
    const { isGroup } = this.decodeThreadId(threadId);

    if (isGroup === true) {
      return;
    }

    try {
      await (await this.getApiClient()).chats.typing.start(chatId);
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
    const verification = this.webhookVerifier
      ? await this.verifyTrustedWebhook(request)
      : await verifyLinqWebhookRequest(request, await this.getSigningSecret());

    if (!verification.ok) {
      return verification.response;
    }

    const { event } = verification;

    if (this.chat && isMessageReceivedWebhookEvent(event) && event.data.direction === "inbound") {
      const chatId = event.data.chat.id;
      const isGroup = event.data.chat.is_group ?? undefined;

      // isDM() only trusts known chats, so resolve group/DM identity before
      // dispatching when the webhook does not carry it.
      if (isGroup === undefined && !this.chatKinds.has(chatId)) {
        try {
          const chat = await (await this.getApiClient()).chats.retrieve(chatId);

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

  private async verifyTrustedWebhook(request: Request): Promise<LinqWebhookVerificationResult> {
    const rawBody = new Uint8Array(await request.arrayBuffer());

    try {
      const result = await this.webhookVerifier?.(request, rawBody);
      if (result === false) {
        return { ok: false, response: new Response("Invalid Linq webhook", { status: 401 }) };
      }
    } catch {
      return { ok: false, response: new Response("Invalid Linq webhook", { status: 401 }) };
    }

    try {
      return {
        ok: true,
        event: JSON.parse(new TextDecoder().decode(rawBody)) as LinqAPIV3.UnwrapWebhookEvent,
      };
    } catch {
      return { ok: false, response: new Response("Invalid JSON", { status: 400 }) };
    }
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
    return parseLinqMessage(raw, (platformData) => this.encodeThreadId(platformData));
  }

  // Rebuild fetchData after an attachment is serialized to the queue and back.
  // Linq media lives on permanent cdn.linqapp.com URLs, so the stored URL is all
  // we need to re-download.
  rehydrateAttachment(attachment: Attachment): Attachment {
    const url = attachment.fetchMetadata?.url ?? attachment.url;

    if (!url) {
      return attachment;
    }

    return {
      ...attachment,
      fetchData: async () => {
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`Failed to fetch Linq attachment ${url}: ${response.status}`);
        }

        return Buffer.from(await response.arrayBuffer());
      },
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
