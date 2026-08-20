import type { AdapterPostableMessage } from "chat";

export type LinqPreferredService = "iMessage" | "RCS" | "SMS";

export type LinqScreenEffectName =
  | "confetti"
  | "fireworks"
  | "lasers"
  | "sparkles"
  | "celebration"
  | "hearts"
  | "love"
  | "balloons"
  | "happy_birthday"
  | "echo"
  | "spotlight";

export type LinqBubbleEffectName = "slam" | "loud" | "gentle" | "invisible";

export type LinqMessageEffect =
  | { readonly type: "screen"; readonly name: LinqScreenEffectName }
  | { readonly type: "bubble"; readonly name: LinqBubbleEffectName };

export type LinqTextDecoration =
  | {
      readonly range: readonly [start: number, end: number];
      readonly style: "bold" | "italic" | "strikethrough" | "underline";
    }
  | {
      readonly range: readonly [start: number, end: number];
      readonly animation:
        | "big"
        | "small"
        | "shake"
        | "nod"
        | "explode"
        | "ripple"
        | "bloom"
        | "jitter";
    };

/** Linq-only send metadata. Each field is translated only when its capability is implemented. */
export interface LinqMessageOptions {
  readonly preferredService?: LinqPreferredService;
  readonly effect?: LinqMessageEffect;
  readonly decorations?: readonly LinqTextDecoration[];
  readonly richLink?: string | URL;
}

type LinqPostableContent = Exclude<AdapterPostableMessage, string>;

/** An ordinary Chat SDK postable carrying an immutable Linq send-time metadata snapshot. */
export type LinqPostableMessage = LinqPostableContent & {
  readonly linq: Readonly<LinqMessageOptions>;
};

/**
 * Attach Linq-specific send metadata without changing the ordinary Chat SDK transport.
 * Strings become `{ raw }` postables; object postables retain their standard discriminant.
 */
export function linqMessage(
  content: AdapterPostableMessage,
  options: LinqMessageOptions = {},
): LinqPostableMessage {
  const linq = snapshotOptions(options);
  const postable = typeof content === "string" ? { raw: content, linq } : { ...content, linq };

  return Object.freeze(postable) as LinqPostableMessage;
}

function snapshotOptions(options: LinqMessageOptions): Readonly<LinqMessageOptions> {
  const effect = options.effect ? Object.freeze({ ...options.effect }) : undefined;
  const decorations = options.decorations
    ? Object.freeze(
        options.decorations.map((decoration) =>
          Object.freeze({
            ...decoration,
            range: Object.freeze([...decoration.range]) as readonly [number, number],
          }),
        ),
      )
    : undefined;
  const richLink = options.richLink instanceof URL ? options.richLink.toString() : options.richLink;

  return Object.freeze({
    ...(options.preferredService === undefined
      ? {}
      : { preferredService: options.preferredService }),
    ...(effect === undefined ? {} : { effect }),
    ...(decorations === undefined ? {} : { decorations }),
    ...(richLink === undefined ? {} : { richLink }),
  });
}
