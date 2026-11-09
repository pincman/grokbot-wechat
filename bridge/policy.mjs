/**
 * Decisions for the official OpenClaw WeChat plugin bridge.
 * No network, no iLink, no client identity. The host plugin and reply command call these.
 */

export const CHANNEL_IDS = new Set(["openclaw-weixin", "weixin", "wechat"]);

export function claimsChannel(channel) {
  return CHANNEL_IDS.has(normalizeId(channel));
}

/** Labels the official plugin puts in Body for media that has no text. */
export const MEDIA_BODIES = new Set(["[图片]", "[视频]", "[文件]", "[语音]"]);

export function normalizeId(value) {
  return String(value ?? "").trim();
}

const WEIXIN_USER_ID = /^[^:@\s]+@im\.wechat$/;
const WEIXIN_PREFIXES = ["openclaw-weixin:", "weixin:", "wechat:", "user:", "channel:", "chat:"];

/**
 * One exact prefix, then the full WeChat user id. Substring and case changes do not match.
 * OpenClaw 2026.11.2 strips channel:/chat:/user: and `<channelId>:` once before the hook.
 */
export function canonicalWeixinUserId(value) {
  let raw = normalizeId(value);
  if (!raw || /[\s\u0000]/.test(raw)) return "";
  for (const prefix of WEIXIN_PREFIXES) {
    if (raw.startsWith(prefix)) {
      raw = raw.slice(prefix.length);
      break;
    }
  }
  return WEIXIN_USER_ID.test(raw) ? raw : "";
}

/**
 * OpenClaw 2026.11.2 before_dispatch sets senderId from ctx.SenderId.
 * @tencent-weixin/openclaw-weixin@2.4.10 never sets SenderId; it sets From, To,
 * and OriginatingTo to from_user_id. The hook context copies that peer into
 * conversationId. event.from is not on this hook. Account id is never a sender.
 * A direct-message peer is used only when no explicit sender is present.
 * Differing explicit and peer ids fail closed.
 */
export function selectWeixinSender({ senderId, event, ctx } = {}) {
  if (event?.isGroup || ctx?.isGroup) return { senderId: "", reason: "group" };
  const explicitRaw = senderId ?? event?.senderId ?? ctx?.senderId;
  const peerRaw = ctx?.conversationId;
  const fromRaw = event?.from;
  const explicit = canonicalWeixinUserId(explicitRaw);
  const peer = canonicalWeixinUserId(peerRaw);
  const from = canonicalWeixinUserId(fromRaw);
  if (normalizeId(explicitRaw) && !explicit) return { senderId: "", reason: "sender-invalid" };
  if (normalizeId(fromRaw) && !from) return { senderId: "", reason: "sender-invalid" };
  const ids = [...new Set([explicit, peer, from].filter(Boolean))];
  if (ids.length > 1) return { senderId: "", reason: "sender-ambiguous" };
  if (ids.length === 1) return { senderId: ids[0] };
  if (normalizeId(peerRaw)) return { senderId: "", reason: "sender-invalid" };
  return { senderId: "", reason: "sender-missing" };
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
  const envRaw = normalizeId(envOwner);
  const scannedRaw = normalizeId(scannedOwner);
  const env = canonicalWeixinUserId(envRaw);
  const scanned = canonicalWeixinUserId(scannedRaw);
  if (envRaw && !env) return { ok: false, reason: "owner-invalid" };
  if (scannedRaw && !scanned) return { ok: false, reason: "owner-invalid" };
  if ((accountCount ?? 0) > 1 && !env && !scanned) {
    return { ok: false, reason: "account-ambiguous" };
  }
  if (!env && !scanned) return { ok: false, reason: "owner-unbound" };
  if (env && scanned && env !== scanned) return { ok: false, reason: "owner-mismatch" };
  return { ok: true, ownerId: env || scanned };
}

export function classifyInbound({ channel, ownerId, senderId, senderReason, body, messageId, seen }) {
  if (!CHANNEL_IDS.has(normalizeId(channel))) return { action: "skip" };
  const owner = canonicalWeixinUserId(ownerId);
  const sender = canonicalWeixinUserId(senderId);
  if (!owner) return { action: "foreign", reason: normalizeId(ownerId) ? "owner-invalid" : "owner-unbound" };
  if (!sender) return { action: "foreign", reason: senderReason || "sender-missing" };
  if (sender !== owner) return { action: "foreign", reason: "sender-mismatch" };
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
      "On the box run node bridge/reply-ssh.mjs \"reply\" --reply-to-ms <trigger_ms> --from-user-id <from_user_id>. Prod checks that id against the scanned owner and exits 4 when trigger_ms is stale. Send nothing on exit 4. Do not read a box state file.",
  };
}

export function decideReply({ ownerId, target, replyToMs, lastInboundMs }) {
  const owner = canonicalWeixinUserId(ownerId);
  const to = canonicalWeixinUserId(target) || owner;
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
