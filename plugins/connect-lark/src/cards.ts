// @oh-summy/connect-lark — CardKit building helpers.
//
// Two outbound paths (ARCHITECTURE §3.2):
//   1) Plain markdown streaming -> channel.stream(to, { markdown }) — SDK-owned CardKit
//   2) Rich cards (title color / footer / buttons) -> caller supplies raw CardKit JSON
//
// This module provides (2): a fixed layout helper + a stream-markdown wrapper.
// The layout is intentionally ONE shape (ARCHITECTURE §4: "first version only one layout").

/** CardKit JSON 2.0 color tokens for header.template. */
export type CardColor = "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey";

export interface RichCardOptions {
  title: string;
  color: CardColor;
  /** Markdown lines. "---" renders as a horizontal rule. */
  lines: string[];
  /** Footer small text (the "bottom note"). */
  note?: string;
  /** Optional button(s). Each gets a url or a callback value. */
  buttons?: Array<{ text: string; url?: string; value?: string }>;
}

/**
 * Build a CardKit JSON 2.0 object with header + body elements.
 *
 * This is the "raw CardKit JSON" path — the SDK does NOT own this structure.
 * The caller must provide it (ARCHITECTURE §3.2).
 */
export function richCard(opts: RichCardOptions): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  for (const line of opts.lines) {
    if (line === "---") elements.push({ tag: "hr" });
    else elements.push({ tag: "div", text: { tag: "lark_md", content: line } });
  }
  if (opts.buttons && opts.buttons.length > 0) {
    const actions = opts.buttons.map((b) => ({
      tag: "button",
      text: { tag: "plain_text", content: b.text },
      type: "default",
      ...(b.url ? { url: b.url } : {}),
      ...(b.value ? { value: b.value } : {}),
    }));
    elements.push({ tag: "action", actions });
  }
  if (opts.note) {
    // CardKit 2.0 does not accept the legacy `note` tag. Use a plain-text
    // div for the small footer instead.
    elements.push({ tag: "div", text: { tag: "plain_text", content: opts.note } });
  }
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: opts.title },
      template: opts.color,
    },
    body: { elements },
  };
}

/**
 * Stream plain markdown to a chat via channel.stream().
 *
 * The SDK owns CardKit create + atomic update + finalize here — no raw JSON needed.
 * Returns the SendResult so the caller can track the message ID.
 */
export async function streamMarkdown(
  channel: { stream: (to: string, input: { markdown: (c: { append: (s: string) => void }) => Promise<void> }) => Promise<unknown> },
  to: string,
  getDelta: () => Promise<string | null>,
): Promise<unknown> {
  return channel.stream(to, {
    markdown: async (c) => {
      while (true) {
        const delta = await getDelta();
        if (delta === null) break;
        if (delta.length > 0) c.append(delta);
      }
    },
  });
}

/**
 * Stream a rich card via channel.stream({ card: { initial, producer } }).
 *
 * The caller provides the full card JSON; the SDK handles atomic updates.
 */
export async function streamRichCard(
  channel: { stream: (to: string, input: { card: { initial: object; producer: (c: { update: (next: object) => void }) => Promise<void> } }) => Promise<unknown> },
  to: string,
  initial: object,
  getUpdate: () => Promise<object | null>,
): Promise<unknown> {
  return channel.stream(to, {
    card: {
      initial,
      producer: async (c) => {
        while (true) {
          const update = await getUpdate();
          if (update === null) break;
          c.update(update);
        }
      },
    },
  });
}