import { BaseFormatConverter, parseMarkdown, toPlainText } from "chat";
import type { CardElement, FormattedContent } from "chat";

import { renderLinqCardText } from "./cards.js";

export class LinqFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): FormattedContent {
    return parseMarkdown(platformText);
  }

  fromAst(ast: FormattedContent): string {
    return toPlainText(ast);
  }

  // Linq renders text verbatim, so the default `**bold**` markdown fallback
  // would show literal asterisks. Use the Linq-specific plain-text rendering.
  protected override cardToFallbackText(card: CardElement): string {
    return renderLinqCardText(card);
  }
}
