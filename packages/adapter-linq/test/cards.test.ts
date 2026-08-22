import {
  Actions,
  Button,
  Card,
  CardLink,
  CardText,
  Divider,
  Field,
  Fields,
  Image,
  LinkButton,
  Table,
} from "chat";
import type { CardElement } from "chat";
import { describe, expect, it, vi } from "vitest";

import { createLinqAdapter } from "../src/adapter";
import { collectCardImageUrls, extractCardElement } from "../src/cards";
import { compileLinqCardText } from "../src/message-compiler";

describe("compileLinqCardText", () => {
  it("renders a full card as clean plain text", () => {
    const card = Card({
      title: "Order #1234",
      subtitle: "Placed today",
      children: [
        CardText("Your order has been **received**!"),
        Fields([Field({ label: "Name", value: "Eve" }), Field({ label: "Total", value: "$42" })]),
        CardLink({ url: "https://example.com/order/1234", label: "View order" }),
        Divider(),
        Actions([
          Button({ id: "approve", label: "Approve", style: "primary" }),
          Button({ id: "reject", label: "Reject", style: "danger" }),
          LinkButton({ url: "https://example.com/help", label: "Get help" }),
        ]),
      ],
    });

    expect(compileLinqCardText(card).text).toBe(
      [
        "Order #1234",
        "Placed today",
        "Your order has been received!",
        "Name: Eve",
        "Total: $42",
        "View order: https://example.com/order/1234",
        "———",
        "Options: Approve, Reject",
        "Get help: https://example.com/help",
      ].join("\n"),
    );
  });

  it("strips markdown from card text instead of sending literal asterisks", () => {
    const card = Card({
      children: [CardText("**Bold** and _italic_ and [a link](https://example.com)")],
    });

    const text = compileLinqCardText(card).text;

    expect(text).not.toContain("**");
    expect(text).not.toContain("_italic_");
    expect(text).toContain("Bold and italic");
  });

  it("omits HTTPS images from text but keeps non-HTTPS image URLs visible", () => {
    const card = Card({
      children: [
        Image({ url: "https://example.com/photo.png", alt: "Photo" }),
        Image({ url: "http://internal.local/scan.png", alt: "Scan" }),
      ],
    });

    expect(compileLinqCardText(card).text).toBe("Scan: http://internal.local/scan.png");
  });

  it("renders tables as ascii text", () => {
    const card = Card({
      children: [
        Table({
          headers: ["Name", "Role"],
          rows: [["Alice", "Engineer"]],
        }),
      ],
    });

    const text = compileLinqCardText(card).text;

    expect(text).toContain("Name");
    expect(text).toContain("Alice");
    expect(text).toContain("Engineer");
  });

  it("renders select options inside actions", () => {
    const card: CardElement = {
      type: "card",
      children: [
        {
          type: "actions",
          children: [
            {
              type: "select",
              id: "priority",
              label: "Priority",
              options: [
                { label: "High", value: "high" },
                { label: "Low", value: "low" },
              ],
            },
          ],
        },
      ],
    };

    expect(compileLinqCardText(card).text).toBe("Priority: High, Low");
  });

  it("renders nested section content", () => {
    const card = Card({
      children: [
        {
          type: "section",
          children: [CardText("Inside a section"), CardLink({ url: "https://example.com" })],
        },
      ],
    });

    expect(compileLinqCardText(card as CardElement).text).toBe(
      "Inside a section\nhttps://example.com",
    );
  });
});

describe("collectCardImageUrls", () => {
  it("collects the header image and image elements, including nested sections", () => {
    const card = Card({
      imageUrl: "https://example.com/header.png",
      children: [
        Image({ url: "https://example.com/body.png" }),
        {
          type: "section",
          children: [Image({ url: "https://example.com/nested.png" })],
        },
      ],
    });

    expect(collectCardImageUrls(card)).toEqual([
      "https://example.com/header.png",
      "https://example.com/body.png",
      "https://example.com/nested.png",
    ]);
  });

  it("skips non-HTTPS image URLs", () => {
    const card = Card({
      imageUrl: "http://example.com/header.png",
      children: [Image({ url: "http://example.com/body.png" })],
    });

    expect(collectCardImageUrls(card)).toEqual([]);
  });
});

describe("extractCardElement", () => {
  it("extracts bare card elements and { card } postables", () => {
    const card = Card({ title: "Hi" });

    expect(extractCardElement(card)).toBe(card);
    expect(extractCardElement({ card })).toBe(card);
  });

  it("returns null for non-card postables", () => {
    expect(extractCardElement("hello")).toBeNull();
    expect(extractCardElement({ markdown: "hello" })).toBeNull();
  });
});

describe("LinqAdapter.postMessage with cards", () => {
  it("sends card fallback text plus image media parts", async () => {
    const { adapter, send } = createCardTestAdapter();

    const card = Card({
      title: "Order #1234",
      imageUrl: "https://example.com/header.png",
      children: [
        CardText("Your order has been **received**!"),
        Image({ url: "https://example.com/receipt.png", alt: "Receipt" }),
      ],
    });

    await adapter.postMessage("linq:chat-123", card);

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [
          {
            type: "text",
            value: "Order #1234\nYour order has been received!",
            text_decorations: [{ range: [32, 40], style: "bold" }],
          },
          { type: "media", url: "https://example.com/header.png" },
          { type: "media", url: "https://example.com/receipt.png" },
        ],
      },
    });
  });

  it("still sends a card that has no title or text content", async () => {
    const { adapter, send } = createCardTestAdapter();

    const card = Card({
      children: [
        Image({ url: "https://example.com/photo.png" }),
        Actions([Button({ id: "yes", label: "Yes" }), Button({ id: "no", label: "No" })]),
      ],
    });

    await adapter.postMessage("linq:chat-123", card);

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [
          { type: "text", value: "Options: Yes, No" },
          { type: "media", url: "https://example.com/photo.png" },
        ],
      },
    });
  });

  it("sends an image-only card as a media-only message", async () => {
    const { adapter, send } = createCardTestAdapter();

    const card = Card({
      children: [Image({ url: "https://example.com/photo.png" })],
    });

    await adapter.postMessage("linq:chat-123", card);

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [{ type: "media", url: "https://example.com/photo.png" }],
      },
    });
  });

  it("warns when a card's buttons are flattened so the poster gets feedback", async () => {
    const { adapter, warn } = createCardTestAdapter();

    await adapter.postMessage(
      "linq:chat-123",
      Card({
        children: [Actions([Button({ id: "approve", label: "Approve" })])],
      }),
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("onAction"));

    warn.mockClear();

    await adapter.postMessage("linq:chat-123", Card({ title: "No actions here" }));

    expect(warn).not.toHaveBeenCalled();
  });

  it("prefers explicit fallbackText while still attaching card images", async () => {
    const { adapter, send } = createCardTestAdapter();

    const card = Card({
      title: "Ignored title",
      children: [Image({ url: "https://example.com/photo.png" })],
    });

    await adapter.postMessage("linq:chat-123", { card, fallbackText: "Custom fallback" });

    expect(send).toHaveBeenCalledWith("chat-123", {
      message: {
        idempotency_key: expect.any(String),
        parts: [
          { type: "text", value: "Custom fallback" },
          { type: "media", url: "https://example.com/photo.png" },
        ],
      },
    });
  });
});

function createCardTestAdapter() {
  const adapter = createLinqAdapter({
    apiKey: "test-key",
    signingSecret: "whsec_dGVzdC1zZWNyZXQ=",
  });
  const send = vi.fn(async (chatId: string, _body: unknown) => ({
    chat_id: chatId,
    message: {
      id: "outbound-message-id",
      created_at: "2026-07-18T00:00:00.000Z",
      delivery_status: "queued",
      is_read: false,
      parts: [],
      sent_at: null,
    },
  }));

  (adapter as unknown as { apiClient: { chats: { messages: { send: typeof send } } } }).apiClient =
    {
      chats: { messages: { send } },
    };

  const warn = vi.fn();

  (adapter as unknown as { logger: { warn: typeof warn } }).logger = { warn };

  return { adapter, send, warn };
}
