import { isCardElement, markdownToPlainText, tableElementToAscii } from "chat";
import type { ActionsElement, AdapterPostableMessage, CardChild, CardElement } from "chat";

import { isRecord } from "./guards.js";

// Linq (iMessage/SMS) has no rich-card or interactive primitives, so cards are
// flattened to their native equivalent: plain text plus real media parts for
// images. Buttons and selects cannot dispatch Chat SDK actions over iMessage;
// their labels are still rendered so recipients see what the card offers.

const DIVIDER_LINE = "———";

// Pull the card element off a postable, whether it arrived as a bare
// CardElement (JSX path) or a `{ card, fallbackText }` object.
export function extractCardElement(message: AdapterPostableMessage): CardElement | null {
  if (typeof message === "string" || !isRecord(message)) {
    return null;
  }

  if (isCardElement(message)) {
    return message;
  }

  if (isCardElement(message.card)) {
    return message.card;
  }

  return null;
}

// Linq downloads media parts itself, so only public HTTPS URLs can be sent as
// real images. Anything else stays in the text fallback.
function isSendableImageUrl(url: string): boolean {
  return url.startsWith("https://");
}

// Image URLs (header image + Image elements, including nested sections) that
// should be sent as Linq media parts alongside the card text.
export function collectCardImageUrls(card: CardElement): string[] {
  const urls: string[] = [];

  if (card.imageUrl && isSendableImageUrl(card.imageUrl)) {
    urls.push(card.imageUrl);
  }

  collectChildImageUrls(card.children, urls);

  return urls;
}

function collectChildImageUrls(children: CardChild[], urls: string[]): void {
  for (const child of children) {
    if (child.type === "image" && isSendableImageUrl(child.url)) {
      urls.push(child.url);
    } else if (child.type === "section") {
      collectChildImageUrls(child.children, urls);
    }
  }
}

// Render a card as plain text for Linq. Unlike the Chat SDK's default fallback
// this strips markdown (iMessage renders `**` literally), keeps links, tables,
// and action labels, and skips images that are sent as real media parts.
export function renderLinqCardText(card: CardElement): string {
  const blocks: string[] = [];

  if (card.title) {
    blocks.push(card.title);
  }

  if (card.subtitle) {
    blocks.push(card.subtitle);
  }

  for (const child of card.children) {
    const text = renderCardChild(child);

    if (text) {
      blocks.push(text);
    }
  }

  return blocks.join("\n");
}

function renderCardChild(child: CardChild): string | null {
  switch (child.type) {
    case "text":
      return markdownToPlainText(child.content).trim() || null;
    case "fields":
      return child.children.map((field) => `${field.label}: ${field.value}`).join("\n");
    case "link":
      return renderLabeledUrl(child.label, child.url);
    case "divider":
      return DIVIDER_LINE;
    case "image":
      // Sendable images become media parts; keep the rest visible as text.
      return isSendableImageUrl(child.url) ? null : renderLabeledUrl(child.alt, child.url);
    case "table":
      return tableElementToAscii(child.headers, child.rows);
    case "section": {
      const lines = child.children
        .map((sectionChild) => renderCardChild(sectionChild))
        .filter((line): line is string => Boolean(line));

      return lines.length > 0 ? lines.join("\n") : null;
    }
    case "actions":
      return renderActions(child);
    default:
      return null;
  }
}

function renderActions(actions: ActionsElement): string | null {
  const lines: string[] = [];
  const buttonLabels: string[] = [];

  for (const element of actions.children) {
    switch (element.type) {
      case "button":
        buttonLabels.push(element.label);
        break;
      case "link-button": {
        const line = renderLabeledUrl(element.label, element.url);

        if (line) {
          lines.push(line);
        }

        break;
      }
      case "select":
      case "radio_select": {
        const options = element.options.map((option) => option.label).join(", ");

        lines.push(options ? `${element.label}: ${options}` : element.label);
        break;
      }
      default:
        break;
    }
  }

  // Buttons cannot trigger onAction() over iMessage/SMS; surface the choices as
  // text so the card still communicates what it offers.
  if (buttonLabels.length > 0) {
    lines.unshift(`Options: ${buttonLabels.join(", ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function renderLabeledUrl(label: string | undefined, url: string): string {
  return label && label !== url ? `${label}: ${url}` : url;
}

// True when the card declares buttons or selects — interactive elements whose
// onAction() handlers can never fire over iMessage/SMS.
export function cardHasInteractiveActions(card: CardElement): boolean {
  return childrenHaveInteractiveActions(card.children);
}

function childrenHaveInteractiveActions(children: CardChild[]): boolean {
  return children.some((child) => {
    if (child.type === "section") {
      return childrenHaveInteractiveActions(child.children);
    }

    return (
      child.type === "actions" &&
      child.children.some(
        (element) =>
          element.type === "button" ||
          element.type === "select" ||
          element.type === "radio_select",
      )
    );
  });
}
