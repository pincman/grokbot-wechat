import test from "node:test";
import assert from "node:assert/strict";
import {
  MEDIA_BODIES,
  buildSendArgv,
  buildWebhookBody,
  canonicalWeixinUserId,
  claimsChannel,
  classifyInbound,
  decideReply,
  ownerIdFromAccount,
  resolveOwner,
  selectWeixinSender,
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

test("2026.11.2 hook shape uses conversationId when SenderId is absent", () => {
  const owner = "o9cq809Labc@im.wechat";
  const event = {
    messageId: "123",
    sessionKey: "agent:main:direct:hidden",
    senderId: undefined,
    content: "你好",
    body: "你好",
    channel: "openclaw-weixin",
    isGroup: false,
    timestamp: 1700000000000,
  };
  const ctx = {
    messageId: "123",
    sessionKey: event.sessionKey,
    senderId: undefined,
    channelId: "openclaw-weixin",
    accountId: "b0f5860fdecb-im-bot",
    conversationId: owner,
  };
  const selected = selectWeixinSender({ event, ctx });
  assert.equal(selected.senderId, owner);
  const decision = classifyInbound({
    channel: event.channel,
    ownerId: owner,
    senderId: selected.senderId,
    senderReason: selected.reason,
    body: event.body,
    messageId: event.messageId,
    seen: new Set(),
  });
  assert.equal(decision.action, "forward");
  assert.equal(decision.text, "你好");
  assert.equal(claimsChannel(event.channel), true);
});

test("identity normalization cannot widen the owner", () => {
  const owner = "o9cq809Labc@im.wechat";
  const stranger = "ffff9999@im.wechat";
  assert.equal(selectWeixinSender({
    event: { senderId: stranger, isGroup: false },
    ctx: { conversationId: owner, accountId: owner },
  }).reason, "sender-ambiguous");
  assert.equal(selectWeixinSender({
    event: { senderId: owner },
    ctx: { conversationId: stranger },
  }).reason, "sender-ambiguous");
  assert.equal(selectWeixinSender({
    ctx: { accountId: owner },
  }).reason, "sender-missing");
  assert.equal(selectWeixinSender({
    ctx: { conversationId: `agent:main:${owner}` },
  }).reason, "sender-invalid");
  assert.equal(canonicalWeixinUserId(`user:${owner}`), owner);
  assert.equal(canonicalWeixinUserId(`openclaw-weixin:${owner}`), owner);
  assert.equal(canonicalWeixinUserId(`user:openclaw-weixin:${owner}`), "");
  assert.equal(canonicalWeixinUserId(`${owner}.evil`), "");
  assert.equal(canonicalWeixinUserId(owner.toUpperCase()), "");
  assert.equal(selectWeixinSender({
    event: { isGroup: true },
    ctx: { conversationId: owner },
  }).reason, "group");
  const foreign = classifyInbound({
    channel: "openclaw-weixin",
    ownerId: owner,
    senderId: "",
    senderReason: "sender-ambiguous",
    body: "你好",
    messageId: "9",
    seen: new Set(),
  });
  assert.equal(foreign.action, "foreign");
  assert.equal(foreign.reason, "sender-ambiguous");
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
  assert.equal(claimsChannel("slack"), false);
});
