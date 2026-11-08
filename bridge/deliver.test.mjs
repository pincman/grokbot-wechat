import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliverInbound, postWebhook } from "./deliver.mjs";
import { readScannedOwner } from "./state.mjs";
import { planReply } from "./reply.mjs";

function memoryStore(initial) {
  const state = initial || { seen: [], pending: [], lastInboundMs: 0 };
  return {
    state,
    load: () => state,
    save: (next) => {
      state.seen = next.seen;
      state.pending = next.pending;
      state.lastInboundMs = next.lastInboundMs;
    },
  };
}

test("webhook post refuses non-https and does not call fetch", async () => {
  let called = false;
  const ok = await postWebhook({ text: "x" }, { WECHAT_WEBHOOK_URL: "http://example.test", WECHAT_WEBHOOK_KEY: "k" }, async () => {
    called = true;
    return { status: 200 };
  });
  assert.equal(ok, false);
  assert.equal(called, false);
});

test("inbound filters identity, ignores media, forwards once, and retries a failed post", async () => {
  const store = memoryStore();
  const sent = [];
  let failOnce = true;
  const post = async (body) => {
    if (failOnce) {
      failOnce = false;
      return false;
    }
    sent.push(body);
    return true;
  };
  const deps = {
    postWebhook: post,
    loadBridgeState: store.load,
    saveBridgeState: store.save,
    resolveBoundOwner: () => ({ ok: true, ownerId: "owner@im.wechat" }),
  };
  const foreign = await deliverInbound({
    channel: "openclaw-weixin",
    senderId: "other@im.wechat",
    body: "nope",
    messageId: "1",
    timestamp: 10,
  }, deps);
  assert.equal(foreign.action, "foreign");
  assert.equal(sent.length, 0);

  const media = await deliverInbound({
    channel: "openclaw-weixin",
    senderId: "owner@im.wechat",
    body: "[图片]",
    messageId: "2",
    timestamp: 20,
  }, deps);
  assert.equal(media.action, "ignore-media");

  const first = await deliverInbound({
    channel: "openclaw-weixin",
    senderId: "owner@im.wechat",
    body: "你好",
    messageId: "3",
    timestamp: 30,
  }, deps);
  assert.equal(first.delivered, false);
  assert.equal(store.state.pending.length, 1);
  assert.equal(store.state.seen.includes("3"), false);

  const second = await deliverInbound({
    channel: "openclaw-weixin",
    senderId: "owner@im.wechat",
    body: "下一句",
    messageId: "4",
    timestamp: 40,
  }, deps);
  assert.equal(second.delivered, true);
  assert.deepEqual(sent.map((item) => item.text), ["你好", "下一句"]);
  assert.equal(store.state.pending.length, 0);

  const replay = await deliverInbound({
    channel: "openclaw-weixin",
    senderId: "owner@im.wechat",
    body: "你好",
    messageId: "3",
    timestamp: 30,
  }, deps);
  assert.equal(replay.action, "replay");
  assert.equal(sent.length, 2);
});

test("scanned owner reader ignores the bot token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-accounts-"));
  fs.writeFileSync(path.join(dir, "bot.json"), JSON.stringify({
    token: "do-not-leak",
    userId: "owner@im.wechat",
  }));
  fs.writeFileSync(path.join(dir, "bot.sync.json"), "{}");
  const scanned = readScannedOwner(dir, "bot");
  assert.equal(scanned.userId, "owner@im.wechat");
  assert.equal(JSON.stringify(scanned).includes("do-not-leak"), false);
});

test("reply plan stays on the bound owner", () => {
  const stale = planReply(["晚了", "--reply-to-ms", "1000"], {}, { lastInboundMs: 2000, seen: [], pending: [] }, { ok: true, ownerId: "owner@im.wechat" });
  assert.equal(stale.code, 4);
  const ok = planReply(["好", "--reply-to-ms", "2000", "--account", "bot"], {}, { lastInboundMs: 2000, seen: [], pending: [] }, { ok: true, ownerId: "owner@im.wechat" });
  assert.equal(ok.code, 0);
  assert.equal(ok.argv.includes("--channel"), true);
  assert.equal(ok.argv.includes("openclaw-weixin"), true);
  assert.equal(ok.argv.includes("owner@im.wechat"), true);
  assert.equal(ok.argv.includes("好"), true);
});
