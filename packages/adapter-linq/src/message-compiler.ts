import { isCardElement, parseMarkdown, tableElementToAscii } from "chat";
import type {
  ActionsElement,
  AdapterPostableMessage,
  CardChild,
  CardElement,
  Content,
  FormattedContent,
} from "chat";

import { linqValidationError as validationError } from "./errors.js";
import { isLinqUuid, isRecord } from "./guards.js";
import type {
  LinqMessageEffect,
  LinqMentionOptions,
  LinqPreferredService,
  LinqTextDecoration,
} from "./message.js";
import { normalizeLinqHandle } from "./validation.js";

const DIVIDER_LINE = "———";
const STYLES = new Set(["bold", "italic", "strikethrough", "underline"]);
const ANIMATIONS = new Set([
  "big",
  "small",
  "shake",
  "nod",
  "explode",
  "ripple",
  "bloom",
  "jitter",
]);
const PREFERRED_SERVICES = new Set(["iMessage", "RCS", "SMS"]);
const SCREEN_EFFECTS = new Set([
  "confetti",
  "fireworks",
  "lasers",
  "sparkles",
  "celebration",
  "hearts",
  "love",
  "balloons",
  "happy_birthday",
  "echo",
  "spotlight",
]);
const BUBBLE_EFFECTS = new Set(["slam", "loud", "gentle", "invisible"]);
type LinqDecorationStyle = Extract<LinqTextDecoration, { style: string }>["style"];
type LinqDecorationAnimation = Extract<LinqTextDecoration, { animation: string }>["animation"];

// Keep the provider-shaped result internal to the adapter while retaining the
// exact closed values of the public LinqTextDecoration contract.
export type LinqCompiledDecoration =
  | {
      range: [start: number, end: number];
      style: LinqDecorationStyle;
    }
  | {
      range: [start: number, end: number];
      animation: LinqDecorationAnimation;
    };

export interface CompiledLinqMessageText {
  decorations: LinqCompiledDecoration[];
  mention?: {
    range?: [start: number, end: number];
    target: string;
    targetKind: "handle" | "participant_id";
  };
  text: string;
}

export interface CompiledLinqSendOptions {
  effect?: LinqMessageEffect;
  preferredService?: LinqPreferredService;
  richLink?: string;
}

export interface CompiledLinqMessage {
  content: CompiledLinqMessageText;
  options: CompiledLinqSendOptions;
}

type LinqOptionsRecord = Record<string, unknown> | undefined;

type TextFragment = CompiledLinqMessageText;

/** Compile the primary Linq text part and all inline decorations before any I/O. */
export function compileLinqMessageText(message: AdapterPostableMessage): CompiledLinqMessageText {
  return compileLinqMessageTextWithOptions(
    trimFragment(compilePostable(message)),
    readLinqOptions(message, false),
  );
}

/** Compile all adapter-owned text and request metadata through one validated options snapshot. */
export function compileLinqMessage(message: AdapterPostableMessage): CompiledLinqMessage {
  const rendered = trimFragment(compilePostable(message));
  const linq = readLinqOptions(message, true);
  const content = compileLinqMessageTextWithOptions(rendered, linq);
  const options = compileLinqSendOptionsFromOptions(linq);
  validateCompiledLinqMention(content, options);

  return { content, options };
}

function compileLinqMessageTextWithOptions(
  rendered: TextFragment,
  linq: LinqOptionsRecord,
): CompiledLinqMessageText {
  const mention = compileMention(linq, rendered.text);
  const manual = extractManualDecorations(linq, rendered.text.length);

  if (mention && manual.length > 0) {
    throw validationError("Linq mentions cannot be combined with manual text decorations.");
  }

  if (mention) {
    return {
      text: mention.text,
      decorations: [],
      mention: mention.mention,
    };
  }

  const decorations = normalizeDecorations([...rendered.decorations, ...manual]);

  assertNonOverlappingAnimations(decorations);

  return { text: rendered.text, decorations };
}

/** Replace a standard mention's participant ID with the resolved chat handle. */
export function resolveCompiledLinqMention(
  compiled: CompiledLinqMessageText,
  handle: string,
): CompiledLinqMessageText {
  const mention = compiled.mention;
  if (!mention || mention.targetKind !== "participant_id" || !mention.range) {
    return compiled;
  }

  validateMentionHandle(handle);
  const [start, end] = mention.range;

  return {
    decorations: [],
    text: `${compiled.text.slice(0, start)}${handle}${compiled.text.slice(end)}`,
    mention: {
      range: [start, start + handle.length],
      target: handle,
      targetKind: "handle",
    },
  };
}

/** Validate and compile Linq's message-level service/effect request fields before any I/O. */
export function compileLinqSendOptions(message: AdapterPostableMessage): CompiledLinqSendOptions {
  return compileLinqSendOptionsFromOptions(readLinqOptions(message, true));
}

function compileLinqSendOptionsFromOptions(linq: LinqOptionsRecord): CompiledLinqSendOptions {
  if (!linq) return {};

  const preferredService = validatePreferredService(linq.preferredService);
  const effect = validateEffect(linq.effect);
  const richLink = validateRichLink(linq.richLink);
  const manualDecorations = linq.decorations;

  if (manualDecorations !== undefined && !Array.isArray(manualDecorations)) {
    throw validationError("Linq message decorations must be an array.");
  }

  if (
    (preferredService === "RCS" || preferredService === "SMS") &&
    (effect !== undefined || (manualDecorations?.length ?? 0) > 0)
  ) {
    throw validationError(
      `Linq preferred service ${preferredService} cannot be combined with effects or manual decorations.`,
    );
  }

  return {
    ...(effect === undefined ? {} : { effect }),
    ...(preferredService === undefined ? {} : { preferredService }),
    ...(richLink === undefined ? {} : { richLink }),
  };
}

/** Cross-field validation that depends on both compiled content and send metadata. */
export function validateCompiledLinqMention(
  compiled: CompiledLinqMessageText,
  options: CompiledLinqSendOptions,
): void {
  if (compiled.mention && options.richLink !== undefined) {
    throw validationError("Linq mentions cannot be combined with rich links.");
  }
}

/** Compile Linq's deterministic static-card fallback, including CardText markdown styles. */
export function compileLinqCardText(card: CardElement): CompiledLinqMessageText {
  const blocks: TextFragment[] = [];

  if (card.title) blocks.push(plain(card.title));
  if (card.subtitle) blocks.push(plain(card.subtitle));

  for (const child of card.children) {
    const block = compileCardChild(child);
    if (block && block.text) blocks.push(block);
  }

  return joinFragments(blocks, "\n", false);
}

function compilePostable(message: AdapterPostableMessage): TextFragment {
  if (typeof message === "string") return plain(message);

  if (isCardElement(message)) return compileLinqCardText(message);

  if (isRecord(message)) {
    if (typeof message.raw === "string") return plain(message.raw);
    if (typeof message.markdown === "string") return compileAst(parseMarkdown(message.markdown));
    if (isRecord(message.ast) && message.ast.type === "root") {
      return compileAst(message.ast as unknown as FormattedContent);
    }
    if (isCardElement(message.card)) {
      return typeof message.fallbackText === "string" && message.fallbackText
        ? plain(message.fallbackText)
        : compileLinqCardText(message.card);
    }
  }

  return plain("");
}

function compileMention(
  linq: LinqOptionsRecord,
  text: string,
): { text: string; mention: NonNullable<CompiledLinqMessageText["mention"]> } | undefined {
  const explicit = extractExplicitMention(linq);
  const token = parseMentionToken(text);

  if (explicit && token) {
    throw validationError(
      "Linq messages must use either one Chat SDK mention token or explicit mention options, not both.",
    );
  }

  if (explicit) {
    if (!text) {
      throw validationError("Linq mentions require one non-empty text part.");
    }
    const range = validateMentionRange(explicit.range, text.length);
    return {
      text,
      mention: {
        ...(range === undefined ? {} : { range }),
        target: validateMentionHandle(explicit.handle),
        targetKind: "handle",
      },
    };
  }

  if (!token) return undefined;
  const { end, start, target } = token;

  const targetKind = isLinqUuid(target) ? "participant_id" : "handle";
  if (targetKind === "handle") validateMentionHandle(target);
  const replaced = `${text.slice(0, start)}${target}${text.slice(end)}`;

  return {
    text: replaced,
    mention: {
      range: [start, start + target.length],
      target,
      targetKind,
    },
  };
}

type MentionToken = {
  /** Index immediately after the token's closing `>`. */
  end: number;
  start: number;
  target: string;
};

/**
 * Recognize exactly one complete Chat SDK `<@target>` token without treating a
 * valid-looking substring inside malformed delimiters as native mention intent.
 */
function parseMentionToken(text: string): MentionToken | undefined {
  const openings: number[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const opening = text.indexOf("<@", cursor);
    if (opening === -1) break;
    openings.push(opening);
    cursor = opening + 2;
  }

  if (openings.length === 0) return undefined;
  if (openings.length !== 1) {
    throw validationError("Linq messages support exactly one complete native mention token.");
  }

  const start = openings[0]!;
  const closing = text.indexOf(">", start + 2);
  if (closing === -1) {
    throw validationError("Linq mention tokens must be complete <@target> values.");
  }

  const target = text.slice(start + 2, closing);
  const ambiguouslyWrapped = text[start - 1] === "<" || text[closing + 1] === ">";
  if (!target || target.includes("<") || ambiguouslyWrapped) {
    throw validationError("Linq mention tokens must be complete, non-nested <@target> values.");
  }

  return { end: closing + 1, start, target };
}

function extractExplicitMention(linq: LinqOptionsRecord): LinqMentionOptions | undefined {
  if (!linq) return undefined;

  const value = linq.mention;
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw validationError("Linq mention options must be an object.");
  }

  return value as unknown as LinqMentionOptions;
}

function validateMentionRange(
  value: unknown,
  textLength: number,
): [start: number, end: number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) {
    throw validationError("Linq mention ranges must be [start, end] UTF-16 offsets.");
  }

  const [start, end] = value;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 0 ||
    (start as number) >= (end as number) ||
    (end as number) > textLength
  ) {
    throw validationError(
      "Linq mention ranges must satisfy 0 <= start < end <= rendered text length.",
    );
  }

  return [start as number, end as number];
}

export function validateMentionHandle(value: unknown): string {
  return normalizeLinqHandle(
    value,
    "Linq mention handles must be E.164 phone numbers or email addresses.",
  );
}

function compileAst(ast: FormattedContent): TextFragment {
  return compileAstNode(ast);
}

function compileAstNode(node: Content | FormattedContent): TextFragment {
  const value = nodeValue(node);
  if (value !== null) return plain(value);

  if (node.type === "break") return plain("\n");
  if (node.type === "thematicBreak") return plain("");

  const children = "children" in node && Array.isArray(node.children) ? node.children : [];
  let separator = "";
  let keepEmpty = false;

  switch (node.type) {
    case "root":
      separator = "\n\n";
      break;
    case "list":
    case "listItem":
    case "blockquote":
    case "table":
      separator = "\n";
      break;
    case "tableRow":
      separator = "\t";
      keepEmpty = true;
      break;
    default:
      break;
  }

  let fragments = children.map((child) => compileAstNode(child));
  if (!keepEmpty) {
    fragments =
      node.type === "table"
        ? fragments.filter((fragment) => fragment.text.trim().length > 0)
        : fragments.filter((fragment) => fragment.text.length > 0);
  }

  const result = joinFragments(fragments, separator, keepEmpty);
  const style = derivedStyle(node.type);

  if (style && result.text.length > 0) {
    result.decorations.push({ range: [0, result.text.length], style });
  }

  return result;
}

function nodeValue(node: Content | FormattedContent): string | null {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("alt" in node && typeof node.alt === "string") return node.alt;
  return null;
}

function derivedStyle(type: string): LinqDecorationStyle | undefined {
  switch (type) {
    case "strong":
      return "bold";
    case "emphasis":
      return "italic";
    case "delete":
      return "strikethrough";
    default:
      return undefined;
  }
}

function compileCardChild(child: CardChild): TextFragment | null {
  switch (child.type) {
    case "text": {
      const compiled = trimFragment(compileAst(parseMarkdown(child.content)));
      return compiled.text ? compiled : null;
    }
    case "fields":
      return plain(child.children.map((field) => `${field.label}: ${field.value}`).join("\n"));
    case "link":
      return plain(renderLabeledUrl(child.label, child.url));
    case "divider":
      return plain(DIVIDER_LINE);
    case "image":
      return isSendableImageUrl(child.url) ? null : plain(renderLabeledUrl(child.alt, child.url));
    case "table":
      return plain(tableElementToAscii(child.headers, child.rows));
    case "section": {
      const fragments = child.children
        .map((sectionChild) => compileCardChild(sectionChild))
        .filter((fragment): fragment is TextFragment => Boolean(fragment?.text));
      return fragments.length > 0 ? joinFragments(fragments, "\n", false) : null;
    }
    case "actions":
      return compileActions(child);
    default:
      return null;
  }
}

function compileActions(actions: ActionsElement): TextFragment | null {
  const lines: string[] = [];
  const buttonLabels: string[] = [];

  for (const element of actions.children) {
    switch (element.type) {
      case "button":
        buttonLabels.push(element.label);
        break;
      case "link-button": {
        const line = renderLabeledUrl(element.label, element.url);
        if (line) lines.push(line);
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

  if (buttonLabels.length > 0) lines.unshift(`Options: ${buttonLabels.join(", ")}`);
  return lines.length > 0 ? plain(lines.join("\n")) : null;
}

function validatePreferredService(value: unknown): LinqPreferredService | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PREFERRED_SERVICES.has(value)) {
    throw validationError("Linq preferredService must be iMessage, RCS, or SMS.");
  }
  return value as LinqPreferredService;
}

function validateEffect(value: unknown): LinqMessageEffect | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw validationError("Linq message effect must be an object.");
  }

  const { name, type } = value;
  if (type === "screen" && typeof name === "string" && SCREEN_EFFECTS.has(name)) {
    return { type, name: name as Extract<LinqMessageEffect, { type: "screen" }>["name"] };
  }
  if (type === "bubble" && typeof name === "string" && BUBBLE_EFFECTS.has(name)) {
    return { type, name: name as Extract<LinqMessageEffect, { type: "bubble" }>["name"] };
  }

  throw validationError("Linq message effect type and name must be a supported matching pair.");
}

function validateRichLink(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Array.from(value).length > 2_048
  ) {
    throw validationError("Linq rich links must contain 1-2048 characters.");
  }

  try {
    const url = new URL(value);

    if (url.protocol === "https:" && url.hostname) {
      return value;
    }
  } catch {
    // Fall through to the stable validation error.
  }

  throw validationError("Linq rich links must be valid HTTPS URLs.");
}

function extractManualDecorations(
  linq: LinqOptionsRecord,
  textLength: number,
): LinqCompiledDecoration[] {
  if (!linq) return [];

  const decorations = linq.decorations;
  if (decorations === undefined) return [];
  if (!Array.isArray(decorations)) {
    throw validationError("Linq message decorations must be an array.");
  }

  return decorations.map((decoration, index) =>
    validateManualDecoration(decoration, index, textLength),
  );
}

function validateManualDecoration(
  decoration: unknown,
  index: number,
  textLength: number,
): LinqCompiledDecoration {
  if (!isRecord(decoration) || !Array.isArray(decoration.range) || decoration.range.length !== 2) {
    throw validationError(`Linq decoration ${index} must have a [start, end] range.`);
  }

  const [start, end] = decoration.range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw validationError(`Linq decoration ${index} range endpoints must be integers.`);
  }
  if ((start as number) < 0 || (end as number) > textLength) {
    throw validationError(`Linq decoration ${index} range must stay within the rendered text.`);
  }
  if ((start as number) >= (end as number)) {
    throw validationError(`Linq decoration ${index} range must have start < end.`);
  }

  const hasStyle = Object.hasOwn(decoration, "style");
  const hasAnimation = Object.hasOwn(decoration, "animation");
  if (hasStyle === hasAnimation) {
    throw validationError(`Linq decoration ${index} must specify exactly one style or animation.`);
  }

  const range: [number, number] = [start as number, end as number];
  if (hasStyle) {
    if (typeof decoration.style !== "string" || !STYLES.has(decoration.style)) {
      throw validationError(`Linq decoration ${index} has an unsupported style.`);
    }
    return { range, style: decoration.style as LinqDecorationStyle };
  }

  if (typeof decoration.animation !== "string" || !ANIMATIONS.has(decoration.animation)) {
    throw validationError(`Linq decoration ${index} has an unsupported animation.`);
  }
  return { range, animation: decoration.animation as LinqDecorationAnimation };
}

function normalizeDecorations(decorations: LinqCompiledDecoration[]): LinqCompiledDecoration[] {
  const unique = new Map<string, LinqCompiledDecoration>();
  for (const decoration of decorations) {
    const kind = "style" in decoration ? "style" : "animation";
    const value = "style" in decoration ? decoration.style : decoration.animation;
    unique.set(`${decoration.range[0]}:${decoration.range[1]}:${kind}:${value}`, decoration);
  }

  return [...unique.values()].sort((left, right) => {
    const rangeOrder = left.range[0] - right.range[0] || left.range[1] - right.range[1];
    if (rangeOrder !== 0) return rangeOrder;
    const leftKey = "style" in left ? `0:${left.style}` : `1:${left.animation}`;
    const rightKey = "style" in right ? `0:${right.style}` : `1:${right.animation}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function assertNonOverlappingAnimations(decorations: LinqCompiledDecoration[]): void {
  for (let index = 0; index < decorations.length; index += 1) {
    const decoration = decorations[index]!;
    if (!("animation" in decoration)) continue;

    for (let otherIndex = 0; otherIndex < decorations.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = decorations[otherIndex]!;
      if (rangesOverlap(decoration.range, other.range)) {
        throw validationError("Linq animation ranges cannot overlap styles or other animations.");
      }
    }
  }
}

function rangesOverlap(left: [number, number], right: [number, number]): boolean {
  return left[0] < right[1] && right[0] < left[1];
}

function trimFragment(fragment: TextFragment): TextFragment {
  const text = fragment.text.trim();
  if (!text) return plain("");

  const start = fragment.text.length - fragment.text.trimStart().length;
  const end = start + text.length;
  const decorations = fragment.decorations.flatMap((decoration) => {
    const clippedStart = Math.max(decoration.range[0], start);
    const clippedEnd = Math.min(decoration.range[1], end);
    if (clippedStart >= clippedEnd) return [];
    return [
      {
        ...decoration,
        range: [clippedStart - start, clippedEnd - start],
      } as LinqCompiledDecoration,
    ];
  });

  return { text, decorations };
}

function joinFragments(
  fragments: TextFragment[],
  separator: string,
  keepEmpty: boolean,
): TextFragment {
  const included = keepEmpty ? fragments : fragments.filter((fragment) => fragment.text.length > 0);
  const decorations: LinqCompiledDecoration[] = [];
  let text = "";

  included.forEach((fragment, index) => {
    if (index > 0) text += separator;
    const offset = text.length;
    text += fragment.text;
    decorations.push(
      ...fragment.decorations.map((decoration) => ({
        ...decoration,
        range: [decoration.range[0] + offset, decoration.range[1] + offset] as [number, number],
      })),
    );
  });

  return { text, decorations };
}

function plain(text: string): TextFragment {
  return { text, decorations: [] };
}

function isSendableImageUrl(url: string): boolean {
  return url.startsWith("https://");
}

function renderLabeledUrl(label: string | undefined, url: string): string {
  return label && label !== url ? `${label}: ${url}` : url;
}

function readLinqOptions(message: AdapterPostableMessage, strict: boolean): LinqOptionsRecord {
  if (typeof message === "string" || !isRecord(message) || message.linq === undefined) {
    return undefined;
  }
  if (isRecord(message.linq)) return message.linq;
  if (strict) throw validationError("Linq message options must be an object.");
  return undefined;
}
