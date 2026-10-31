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
  /** Collapsible panels appended after the lines (CardKit 2.0 折叠面板). */
  panels?: Array<{ title: string; content: string; expanded?: boolean }>;
  /** Footer small text (the "bottom note"). */
  note?: string;
  /** Optional button(s). Each gets a url or a callback value. */
  buttons?: Array<{ text: string; url?: string; value?: string }>;
}

/**
 * CardKit 2.0 折叠面板：默认收起，点标题展开。用于「思考过程」——
 * 只保留实测被飞书接受的属性（2.0 拒绝 border.style/background_style 等 1.0 字段）。
 */
function collapsiblePanel(panel: { title: string; content: string; expanded?: boolean }): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded: panel.expanded === true,
    header: {
      title: { tag: "plain_text", content: panel.title },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small_outlined" },
      icon_position: "follow",
    },
    elements: [{ tag: "div", text: { tag: "lark_md", content: panel.content } }],
  };
}

/**
 * Build a CardKit JSON 2.0 object with header + body elements.
 *
 * This is the "raw CardKit JSON" path — the SDK does NOT own this structure.
 * The caller must provide it (ARCHITECTURE §3.2).
 */
export function richCard(opts: RichCardOptions): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  // 折叠面板渲染在正文之前：思考过程先出现，完成后折叠，正文在其下
  if (opts.panels) {
    for (const p of opts.panels) elements.push(collapsiblePanel(p));
  }
  for (const line of opts.lines) {
    if (line === "---") elements.push({ tag: "hr" });
    else elements.push({ tag: "div", text: { tag: "lark_md", content: line } });
  }
  if (opts.buttons && opts.buttons.length > 0) {
    // CardKit 2.0: buttons are direct elements, not an action wrapper.
    for (const b of opts.buttons) {
      const behaviors: Array<Record<string, unknown>> = [];
      if (b.url) behaviors.push({ type: "open_url", default_url: b.url });
      if (b.value) behaviors.push({ type: "callback", value: { value: b.value } });
      elements.push({
        tag: "button",
        text: { tag: "plain_text", content: b.text },
        type: "primary",
        size: "small",
        behaviors,
      });
    }
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
 * Internal helper: stream plain markdown via channel.stream().
 * Not used by the production reply path (which uses rich cards).
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

