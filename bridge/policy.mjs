/**
 * Decisions for the official OpenClaw WeChat plugin bridge.
 * No network, no iLink, no client identity. The host plugin and reply command call these.
 */

export const CHANNEL_IDS = new Set(["openclaw-weixin", "weixin", "wechat"]);

/** Labels the official plugin puts in Body for media that has no text. */
export const MEDIA_BODIES = new Set(["[图片]", "[视频]", "[文件]", "[语音]"]);

export function normalizeId(value) {
  return String(value ?? "").trim();
}

export function isAccountFile(name) {
  return (
    name.endsWith(".json") &&
    !name.endsWith(".sync.json") &&
    !name.endsWith(".context-tokens.json")
  );
}

/**
 * Read only the scanned user id from an official plugin account file.
 * The file also holds the bot token; this function never returns that field.
 */
export function ownerIdFromAccount(data) {
  if (!data || typeof data !== "object") return "";
  return normalizeId(data.userId);
}

export function resolveOwner({ envOwner, scannedOwner, accountCount }) {
  const env = normalizeId(envOwner);
  const scanned = normalizeId(scannedOwner);
  if ((accountCount ?? 0) > 1 && !env && !scanned) {
    return { ok: false, reason: "account-ambiguous" };
  }
  if (!env && !scanned) return { ok: false, reason: "owner-unbound" };
  if (env && scanned && env !== scanned) return { ok: false, reason: "owner-mismatch" };
  return { ok: true, ownerId: env || scanned };
}

export function classifyInbound({ channel, ownerId, senderId, body, messageId, seen }) {
  if (!CHANNEL_IDS.has(normalizeId(channel))) return { action: "skip" };
  const owner = normalizeId(ownerId);
  const sender = normalizeId(senderId);
  if (!owner || sender !== owner) return { action: "foreign" };
  const id = normalizeId(messageId);
  if (id && seen && seen.has(id)) return { action: "replay" };
  const text = String(body ?? "").trim();
  if (!text || MEDIA_BODIES.has(text)) return { action: "ignore-media" };
  return { action: "forward", text, messageId: id };
}

export function buildWebhookBody({ text, senderId, messageId, triggerMs }) {
  return {
    source: "wechat-openclaw",
    text,
    from_user_id: senderId,
    message_id: messageId || undefined,
    trigger_ms: triggerMs ?? undefined,
    reply_rule:
      "Reply with reply.mjs and the same trigger_ms. Exit 4 means a newer WeChat message arrived; send nothing. The target is only the bound owner.",
  };
}

export function decideReply({ ownerId, target, replyToMs, lastInboundMs }) {
  const owner = normalizeId(ownerId);
  const to = normalizeId(target) || owner;
  if (!owner || to !== owner) return { ok: false, code: 2, reason: "not-owner" };
  if (
    replyToMs != null &&
    lastInboundMs != null &&
    Number(lastInboundMs) > Number(replyToMs) + 500
  ) {
    return { ok: false, code: 4, reason: "superseded" };
  }
  return { ok: true, code: 0, target: owner };
}

export function buildSendArgv({ openclawBin, accountId, target, text }) {
  const argv = [
    openclawBin || "openclaw",
    "message",
    "send",
    "--channel",
    "openclaw-weixin",
    "--target",
    target,
    "--message",
    text,
    "--json",
  ];
  if (normalizeId(accountId)) argv.splice(5, 0, "--account", normalizeId(accountId));
  return argv;
}
