import { isCardElement } from "chat";
import type { AdapterPostableMessage, CardChild, CardElement } from "chat";

import { isRecord } from "./guards.js";
import { compileLinqCardText } from "./message-compiler.js";

// Linq (iMessage/SMS) has no rich-card or interactive primitives, so cards are
// flattened to their native equivalent: plain text plus real media parts for
// images. Buttons and selects cannot dispatch Chat SDK actions over iMessage;
// their labels are still rendered so recipients see what the card offers.

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
  return compileLinqCardText(card).text;
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
          element.type === "button" || element.type === "select" || element.type === "radio_select",
      )
    );
  });
}
