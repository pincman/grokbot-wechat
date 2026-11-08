import test from "node:test";
import assert from "node:assert/strict";
import {
  MEDIA_BODIES,
  buildSendArgv,
  buildWebhookBody,
  classifyInbound,
  decideReply,
  ownerIdFromAccount,
  resolveOwner,
} from "./policy.mjs";

test("unbound and mismatched owners fail closed", () => {
  assert.equal(resolveOwner({}).ok, false);
  assert.equal(resolveOwner({ accountCount: 2 }).reason, "account-ambiguous");
  const mismatch = resolveOwner({ envOwner: "a@im.wechat", scannedOwner: "b@im.wechat" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "owner-mismatch");
  assert.equal(resolveOwner({ scannedOwner: "a@im.wechat" }).ownerId, "a@im.wechat");
});

test("account file yields only the scanned user id", () => {
  assert.equal(
    ownerIdFromAccount({ token: "secret-token", userId: "owner@im.wechat", baseUrl: "https://ilinkai.weixin.qq.com" }),
    "owner@im.wechat",
  );
  assert.equal(JSON.stringify(ownerIdFromAccount({ token: "secret-token" })), '""');
});

test("foreign sender is not forwarded", () => {
  const result = classifyInbound({
    channel: "openclaw-weixin",
    ownerId: "owner@im.wechat",
    senderId: "other@im.wechat",
    body: "hello",
    messageId: "1",
    seen: new Set(),
  });
  assert.equal(result.action, "foreign");
});

test("text from the bound owner is forwarded and media placeholders are ignored", () => {
  const seen = new Set();
  const text = classifyInbound({
    channel: "openclaw-weixin",
    ownerId: "owner@im.wechat",
    senderId: "owner@im.wechat",
    body: "你好",
    messageId: "9",
    seen,
  });
  assert.equal(text.action, "forward");
  assert.equal(text.text, "你好");
  for (const label of MEDIA_BODIES) {
    const media = classifyInbound({
      channel: "weixin",
      ownerId: "owner@im.wechat",
      senderId: "owner@im.wechat",
      body: label,
      messageId: label,
      seen,
    });
    assert.equal(media.action, "ignore-media");
  }
  const empty = classifyInbound({
    channel: "wechat",
    ownerId: "owner@im.wechat",
    senderId: "owner@im.wechat",
    body: "  ",
    messageId: "e",
    seen,
  });
  assert.equal(empty.action, "ignore-media");
});

test("a repeated message id is a replay and is not forwarded again", () => {
  const seen = new Set(["9"]);
  const again = classifyInbound({
    channel: "openclaw-weixin",
    ownerId: "owner@im.wechat",
    senderId: "owner@im.wechat",
    body: "你好",
    messageId: "9",
    seen,
  });
  assert.equal(again.action, "replay");
});

test("webhook body is text only", () => {
  const body = buildWebhookBody({
    text: "你好",
    senderId: "owner@im.wechat",
    messageId: "9",
    triggerMs: 50,
  });
  assert.equal(body.source, "wechat-openclaw");
  assert.equal(body.text, "你好");
  assert.equal("files" in body, false);
  assert.equal("raw_items" in body, false);
});

test("reply goes only to the bound owner through the official message command", () => {
  const denied = decideReply({ ownerId: "owner@im.wechat", target: "other@im.wechat" });
  assert.equal(denied.code, 2);
  const stale = decideReply({
    ownerId: "owner@im.wechat",
    replyToMs: 1_000,
    lastInboundMs: 2_000,
  });
  assert.equal(stale.code, 4);
  const ok = decideReply({
    ownerId: "owner@im.wechat",
    replyToMs: 2_000,
    lastInboundMs: 2_100,
  });
  assert.equal(ok.code, 0);
  const argv = buildSendArgv({
    accountId: "bot-im-bot",
    target: ok.target,
    text: "续上了",
  });
  assert.deepEqual(argv.slice(0, 6), [
    "openclaw",
    "message",
    "send",
    "--channel",
    "openclaw-weixin",
    "--account",
  ]);
  assert.equal(argv.includes("bot-im-bot"), true);
  assert.equal(argv.includes("owner@im.wechat"), true);
  assert.equal(argv.includes("续上了"), true);
  assert.equal(argv.join(" ").includes("ilink"), false);
  assert.equal(argv.join(" ").includes("OpenClaw/2.4.9"), false);
});

test("other channels are not claimed by this bridge", () => {
  const result = classifyInbound({
    channel: "slack",
    ownerId: "owner@im.wechat",
    senderId: "owner@im.wechat",
    body: "hello",
    messageId: "1",
    seen: new Set(),
  });
  assert.equal(result.action, "skip");
});
