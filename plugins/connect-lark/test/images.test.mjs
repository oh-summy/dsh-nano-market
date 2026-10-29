import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { admitImage, buildImageContent, IMAGE_UNSUPPORTED_REPLY, MAX_IMAGE_BYTES, FEISHU_CDN_HOSTS, downloadImageBounded } from "../lib/index.mjs";

function makeCtx(info, saveResult) {
  return {
    llm: { resolveModelInfo: async () => info },
    attachments: { saveImages: async () => saveResult },
  };
}

test("admitImage: supports when inputModalities includes image", async () => {
  const ctx = makeCtx({ inputModalities: ["text", "image"] }, [{ id: "ref-1" }]);
  const result = await admitImage(ctx, "p", "m", Buffer.from("fake"));
  assert.equal(result.supported, true);
  assert.equal(result.refs.length, 1);
});

test("admitImage: rejects when inputModalities undefined", async () => {
  const ctx = makeCtx({}, []);
  const result = await admitImage(ctx, "p", "m", Buffer.from("fake"));
  assert.equal(result.supported, false);
  assert.match(result.reason, /does not declare image input/);
});

test("admitImage: rejects when inputModalities empty", async () => {
  const ctx = makeCtx({ inputModalities: [] }, []);
  const result = await admitImage(ctx, "p", "m", Buffer.from("fake"));
  assert.equal(result.supported, false);
});

test("admitImage: rejects when no image modality", async () => {
  const ctx = makeCtx({ inputModalities: ["text"] }, []);
  const result = await admitImage(ctx, "p", "m", Buffer.from("fake"));
  assert.equal(result.supported, false);
});

test("admitImage: rejects oversized image", async () => {
  const ctx = makeCtx({ inputModalities: ["image"] }, []);
  const bigBuf = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  const result = await admitImage(ctx, "p", "m", bigBuf);
  assert.equal(result.supported, false);
  assert.match(result.reason, /exceeds/);
});

test("admitImage: rejects when resolveModelInfo throws", async () => {
  const ctx = { llm: { resolveModelInfo: async () => { throw new Error("boom"); } }, attachments: { saveImages: async () => [] } };
  const result = await admitImage(ctx, "p", "m", Buffer.from("fake"));
  assert.equal(result.supported, false);
  assert.match(result.reason, /cannot verify/);
});

test("admitImage: rejects when saveImages fails", async () => {
  const ctx = { llm: { resolveModelInfo: async () => ({ inputModalities: ["image"] }) }, attachments: { saveImages: async () => { throw new Error("save failed"); } } };
  const result = await admitImage(ctx, "p", "m", Buffer.from("fake"));
  assert.equal(result.supported, false);
  assert.match(result.reason, /saveImages failed/);
});

test("buildImageContent: text-only when unsupported", () => {
  const content = buildImageContent("hello", { supported: false, refs: [] });
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
});

test("buildImageContent: adds image blocks when supported", () => {
  const content = buildImageContent("hello", { supported: true, refs: [{ id: "r1" }, { id: "r2" }] });
  assert.equal(content.length, 3);
  assert.equal(content[1].type, "image");
  assert.equal(content[1].attachment.id, "r1");
  assert.equal(content[2].attachment.id, "r2");
});

test("IMAGE_UNSUPPORTED_REPLY is non-empty string", () => {
  assert.equal(typeof IMAGE_UNSUPPORTED_REPLY, "string");
  assert.ok(IMAGE_UNSUPPORTED_REPLY.length > 0);
});

test("FEISHU_CDN_HOSTS contains known hosts", () => {
  assert.ok(FEISHU_CDN_HOSTS.has("lf3-cdn-tos.bytecdntp.com"));
});

test("admitImage: default route persists JPEG without model gate", async () => {
  let resolveCalls = 0;
  let saved;
  const ctx = {
    llm: { resolveModelInfo: async () => { resolveCalls++; throw new Error("must not gate default route"); } },
    attachments: { saveImages: async (inputs) => { saved = inputs[0]; return [{ id: "jpeg-ref" }]; } },
  };
  const result = await admitImage(ctx, "", "", Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  assert.equal(result.supported, true);
  assert.equal(result.refs[0].id, "jpeg-ref");
  assert.equal(resolveCalls, 0);
  assert.equal(saved.mediaType, "image/jpeg");
});


test("downloadImageBounded: streams to disk and enforces size before buffering", async () => {
  let usedFallback = false;
  const channel = {
    downloadResourceToFile: async (messageId, fileKey, type, destPath) => {
      await fs.promises.writeFile(destPath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    },
    downloadResource: async () => { usedFallback = true; throw new Error("must not buffer"); },
  };
  const result = await downloadImageBounded(channel, "m", "k");
  assert.deepEqual([...result], [0xff, 0xd8, 0xff, 0x00]);
  assert.equal(usedFallback, false);
});

test("downloadImageBounded: rejects oversized files after streaming", async () => {
  const channel = {
    downloadResourceToFile: async (messageId, fileKey, type, destPath) => {
      await fs.promises.writeFile(destPath, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    },
    downloadResource: async () => { throw new Error("must not buffer"); },
  };
  await assert.rejects(() => downloadImageBounded(channel, "m", "k"), /exceeds/);
});
