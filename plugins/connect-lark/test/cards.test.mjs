import { test } from "node:test";
import assert from "node:assert/strict";
import { richCard, streamMarkdown } from "../lib/index.mjs";

test("richCard: builds CardKit JSON with header, elements, and note", () => {
  const card = richCard({
    title: "Test", color: "blue",
    lines: ["Hello", "---", "World"],
    note: "footer text",
  });
  assert.equal(card.schema, "2.0");
  assert.equal(card.header.title.content, "Test");
  assert.equal(card.header.template, "blue");
  const elements = card.body.elements;
  assert.equal(elements.length, 4);
  assert.equal(elements[0].tag, "div");
  assert.equal(elements[1].tag, "hr");
  assert.equal(elements[3].tag, "div");
  assert.equal(elements[3].text.tag, "plain_text");
  assert.equal(elements[3].text.content, "footer text");
});

test("richCard: buttons added as action element", () => {
  const card = richCard({
    title: "T", color: "green", lines: ["content"],
    buttons: [{ text: "Click", url: "https://example.com" }],
  });
  const button = card.body.elements.find((e) => e.tag === "button");
  assert.ok(button);
  assert.equal(button.text.content, "Click");
  assert.equal(button.behaviors[0].type, "open_url");
  assert.equal(button.behaviors[0].default_url, "https://example.com");
});

test("richCard: no note when not provided", () => {
  const card = richCard({ title: "T", color: "red", lines: ["x"] });
  const notes = card.body.elements.filter((e) => e.tag === "note");
  assert.equal(notes.length, 0);
  assert.ok(card.body.elements.every((e) => e.tag !== "note"));
});

test("streamMarkdown: streams deltas and stops on null", async () => {
  const deltas = ["Hello", " ", "World"];
  let idx = 0;
  const controller = { appended: [] };
  const fakeChannel = {
    stream: async (to, input) => {
      await input.markdown({ append: (s) => controller.appended.push(s) });
      return { messageId: "fake-1" };
    },
  };
  const getDelta = async () => (idx < deltas.length ? deltas[idx++] : null);
  const result = await streamMarkdown(fakeChannel, "chat-1", getDelta);
  assert.equal(result.messageId, "fake-1");
  assert.deepEqual(controller.appended, ["Hello", " ", "World"]);
});

test("streamMarkdown: handles empty deltas", async () => {
  const controller = { appended: [] };
  const fakeChannel = {
    stream: async (to, input) => {
      await input.markdown({ append: (s) => controller.appended.push(s) });
      return {};
    },
  };
  await streamMarkdown(fakeChannel, "chat-1", async () => null);
  assert.deepEqual(controller.appended, []);
});