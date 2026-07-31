import { createLinqAdapter } from "@forma/linq-chat-sdk-adapter";
import { createPostgresState } from "@chat-adapter/state-pg";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { ToolLoopAgent, tool } from "ai";
import { Chat, toAiMessages } from "chat";
import type { Message, Thread } from "chat";
import { z } from "zod";

import {
  getChatThreadMessages,
  getLinqWebhookSecret,
  getPostgresPool,
  getTelegramWebhookSecret,
} from "./database";
import { getLinqApiBaseUrl, getLinqApiToken } from "./linq-api";

let bot:
  | Chat<{
      linq: ReturnType<typeof createLinqAdapter>;
      telegram: ReturnType<typeof createTelegramAdapter>;
      whatsapp: ReturnType<typeof createWhatsAppAdapter>;
    }>
  | undefined;

const AI_MODEL = "anthropic/claude-haiku-4.5";
const INITIAL_TYPING_PAUSE_MS = 1_500;
const TYPING_REFRESH_MS = 4_000;
const ANY_MESSAGE_PATTERN = /^[\s\S]*$/;

const reactionToolInputSchema = z
  .object({
    reaction: z
      .string()
      .describe(
        "Reaction to use. Supports like/thumbs_up/👍, dislike/thumbs_down/👎, love/heart/❤️, laugh/😂, emphasize/!, question/?, or any emoji.",
      ),
  })
  .strict();

const editMessageToolInputSchema = z
  .object({
    text: z.string().min(1).describe("The full replacement text for the message."),
  })
  .strict();

type ReactionToolInput = z.infer<typeof reactionToolInputSchema>;
type EditMessageToolInput = z.infer<typeof editMessageToolInputSchema>;

type ReactionToolOutput = {
  action: "added" | "removed";
  reaction: string;
};

type EditMessageToolOutput = {
  action: "edited";
};

type PromptContext = {
  defaultEditMessageId?: string;
  defaultReactionMessageId: string;
  prompt: Awaited<ReturnType<typeof toAiMessages>>;
};

function createAgent(thread: Thread, context: PromptContext) {
  return new ToolLoopAgent({
    model: AI_MODEL,
    instructions: [
      "You are a friendly AI assistant replying in a chat conversation.",
      "Reply like a warm, fun chat companion: playful and a little cheeky when it fits, but never disrespectful.",
      "Keep replies concise, useful, and easy to read in a text message.",
      "Use emojis sparingly in text replies; at most one, and only when it genuinely adds tone.",
      "You can add or remove reactions on messages. Use reactions occasionally when they naturally fit, and always use the reaction tools when the user asks you to react or remove a reaction.",
      "Do not announce that you used a reaction tool unless the user explicitly asks what you did.",
      "If the user explicitly asks for only a reaction, use the tool and reply with a very short acknowledgement.",
      "You can edit your own recent messages when asked. Use the editMessage tool for edits; do not simulate edits by sending the replacement as a normal reply.",
      "The reaction tools target the latest user message. The edit tool targets your latest assistant message.",
      "Never include tool metadata or internal IDs in a chat reply.",
    ].join("\n"),
    tools: createChatTools(thread, context),
  });
}

function createChatTools(thread: Thread, context: PromptContext) {
  return {
    addReaction: tool<ReactionToolInput, ReactionToolOutput>({
      description: "Add a reaction to the latest user message.",
      inputSchema: reactionToolInputSchema,
      execute: async ({ reaction }) => {
        await thread.adapter.addReaction(thread.id, context.defaultReactionMessageId, reaction);

        return { action: "added", reaction };
      },
    }),
    removeReaction: tool<ReactionToolInput, ReactionToolOutput>({
      description: "Remove one of your reactions from the latest user message.",
      inputSchema: reactionToolInputSchema,
      execute: async ({ reaction }) => {
        await thread.adapter.removeReaction(thread.id, context.defaultReactionMessageId, reaction);

        return { action: "removed", reaction };
      },
    }),
    editMessage: tool<EditMessageToolInput, EditMessageToolOutput>({
      description: "Edit your latest assistant message.",
      inputSchema: editMessageToolInputSchema,
      execute: async ({ text }) => {
        const targetMessageId = context.defaultEditMessageId;

        if (!targetMessageId) {
          throw new Error("No assistant message is available to edit.");
        }

        await thread.adapter.editMessage(thread.id, targetMessageId, text);

        return { action: "edited" };
      },
    }),
  };
}

async function postAiReply(thread: Thread, message: Message) {
  await markMessageReadIfSupported(thread, message);

  const context = await buildPromptContext(thread, message);

  if (!context.prompt.length) {
    await thread.post("I can reply to text messages. Send me a message and I'll help.");
    return;
  }

  const refreshTyping = () => {
    void thread.startTyping().catch(() => {});
  };
  refreshTyping();
  const typingInterval = setInterval(refreshTyping, TYPING_REFRESH_MS);

  try {
    await sleep(INITIAL_TYPING_PAUSE_MS);
    const result = await createAgent(thread, context).stream({ prompt: context.prompt });
    const reply = await collectSanitizedText(result.textStream);

    if (reply.trim()) {
      await thread.post({ markdown: reply });
    }
  } finally {
    clearInterval(typingInterval);
  }
}

async function buildPromptContext(thread: Thread, message: Message): Promise<PromptContext> {
  try {
    await thread.refresh();

    const messages = thread.recentMessages.some((recent) => recent.id === message.id)
      ? thread.recentMessages
      : [...thread.recentMessages, message];

    return {
      defaultEditMessageId: latestAssistantMessageId(messages),
      defaultReactionMessageId: message.id,
      prompt: await toAiMessages(messages, {
        includeNames: !thread.isDM,
        transformMessage: stripMessageIdLabelsFromAiMessage,
      }),
    };
  } catch {
    return {
      defaultReactionMessageId: message.id,
      prompt: await toAiMessages(message.text.trim() ? [message] : [], {
        transformMessage: stripMessageIdLabelsFromAiMessage,
      }),
    };
  }
}

function latestAssistantMessageId(messages: Message[]) {
  return messages.findLast((message) => message.author.isMe)?.id;
}

async function collectSanitizedText(stream: AsyncIterable<string>) {
  let text = "";

  for await (const chunk of stream) {
    text += stripMessageIdLabelsFromText(chunk);
  }

  return text;
}

function stripMessageIdLabelsFromText(text: string) {
  return text.replace(/\[message_id:\s*[0-9a-f-]{36}\]\s*/gi, "");
}

function stripMessageIdLabelsFromAiMessage(
  message: Awaited<ReturnType<typeof toAiMessages>>[number],
) {
  if (message.role === "assistant") {
    return { ...message, content: stripMessageIdLabelsFromText(message.content) };
  }

  if (typeof message.content === "string") {
    return { ...message, content: stripMessageIdLabelsFromText(message.content) };
  }

  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type === "text") {
        return { ...part, text: stripMessageIdLabelsFromText(part.text) };
      }

      return part;
    }),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markMessageReadIfSupported(thread: Thread, message: Message) {
  const markAsRead = (thread.adapter as { markAsRead?: unknown }).markAsRead;

  if (typeof markAsRead !== "function") {
    return;
  }

  try {
    await markAsRead.call(thread.adapter, message.id);
  } catch (error) {
    console.warn("Failed to mark chat message as read", error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function threadMessageText(message: unknown) {
  if (!isRecord(message)) {
    return "";
  }

  const author = isRecord(message.author) ? message.author : null;
  const authorName = typeof author?.name === "string" ? author.name : "Someone";
  const text = typeof message.text === "string" ? message.text.trim() : "";

  return text ? `${authorName}: ${text}` : "";
}

async function generateFunOutboundMessage(threadId: string) {
  const recentMessages = await getChatThreadMessages(threadId, 12);
  const transcript = recentMessages.map(threadMessageText).filter(Boolean).join("\n");
  const prompt = [
    "Write one short, fun outbound chat message from the bot.",
    "It can riff on the recent conversation or be a playful unrelated surprise.",
    "Keep it casual, friendly, and under 280 characters. Do not mention that this was triggered by an admin button.",
    transcript ? `Recent conversation:\n${transcript}` : "No recent conversation was available, so send a fun standalone note.",
  ].join("\n\n");
  const result = await new ToolLoopAgent({
    model: AI_MODEL,
    instructions: "You write concise, playful chat messages. Return only the message text.",
  }).stream({ prompt });
  const reply = await collectSanitizedText(result.textStream);

  return reply.trim() || "Tiny chaos check-in: hope your day is being at least 17% more delightful than expected ✨";
}

async function createBot() {
  const telegramSecret = await getTelegramWebhookSecret();
  const telegram = createTelegramAdapter({
    mode: "webhook",
    secretToken: telegramSecret ?? undefined,
  });
  const linqSigningSecret = await getLinqWebhookSecret();
  const linq = createLinqAdapter({
    apiKey: getLinqApiToken() ?? "",
    baseURL: getLinqApiBaseUrl(),
    signingSecret: linqSigningSecret ?? "",
  });
  const whatsapp = createWhatsAppAdapter();

  const chat = new Chat({
    userName: process.env.TELEGRAM_BOT_USERNAME?.trim() || "linqbot",
    adapters: {
      linq,
      telegram,
      whatsapp,
    },
    state: createPostgresState({
      client: getPostgresPool(),
      keyPrefix: "linq-chat-sdk",
    }),
    concurrency: {
      strategy: "debounce",
      debounceMs: 1500,
    },
    fallbackStreamingPlaceholderText: null,
  });

  chat.onDirectMessage(async (thread, message) => {
    await thread.subscribe();
    await postAiReply(thread, message);
  });

  chat.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await postAiReply(thread, message);
  });

  chat.onNewMessage(ANY_MESSAGE_PATTERN, async (thread, message) => {
    if (thread.adapter.name !== "linq" || thread.isDM) {
      return;
    }

    await thread.subscribe();
    await postAiReply(thread, message);
  });

  chat.onSubscribedMessage(async (thread, message) => {
    await postAiReply(thread, message);
  });

  return chat;
}

export async function getBot() {
  if (!bot) {
    bot = await createBot();
  }

  return bot;
}

export async function sendFunMessageToThread(threadId: string) {
  const chat = await getBot();
  await chat.initialize();

  const message = await generateFunOutboundMessage(threadId);
  const sent = await chat.thread(threadId).post({ markdown: message });

  return {
    message,
    sentMessageId: sent.id,
    threadId,
  };
}
