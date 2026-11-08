import { classifyInbound, buildWebhookBody } from "./policy.mjs";
import { loadBridgeState, resolveBoundOwner, saveBridgeState } from "./state.mjs";

export async function postWebhook(body, env = process.env, fetchImpl = globalThis.fetch) {
  const url = String(env.WECHAT_WEBHOOK_URL || "").trim();
  const key = String(env.WECHAT_WEBHOOK_KEY || "").trim();
  if (!url.startsWith("https://") || !key) return false;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return response.status >= 200 && response.status < 300;
}

async function flushPending(state, post) {
  const kept = [];
  for (const item of state.pending) {
    let ok = false;
    try {
      ok = await post(item);
    } catch {
      ok = false;
    }
    if (!ok) {
      kept.push(item);
      continue;
    }
    if (item.message_id && !state.seen.includes(item.message_id)) state.seen.push(item.message_id);
    state.lastInboundMs = Math.max(state.lastInboundMs || 0, Number(item.trigger_ms) || 0);
  }
  state.pending = kept;
}

export async function deliverInbound(input, deps = {}) {
  const post = deps.postWebhook || postWebhook;
  const load = deps.loadBridgeState || loadBridgeState;
  const save = deps.saveBridgeState || saveBridgeState;
  const owner = (deps.resolveBoundOwner || resolveBoundOwner)();
  const state = load();
  const decision = classifyInbound({
    channel: input.channel,
    ownerId: owner.ok ? owner.ownerId : "",
    senderId: input.senderId,
    body: input.body,
    messageId: input.messageId,
    seen: new Set(state.seen),
  });
  if (decision.action === "skip") return decision;
  await flushPending(state, post);
  if (decision.action !== "forward") {
    save(state);
    return decision;
  }
  const payload = buildWebhookBody({
    text: decision.text,
    senderId: input.senderId,
    messageId: decision.messageId,
    triggerMs: Number(input.timestamp) || Date.now(),
  });
  let ok = false;
  try {
    ok = await post(payload);
  } catch {
    ok = false;
  }
  if (ok) {
    if (decision.messageId && !state.seen.includes(decision.messageId)) state.seen.push(decision.messageId);
    state.lastInboundMs = Math.max(state.lastInboundMs || 0, payload.trigger_ms);
    state.pending = state.pending.filter((item) => item.message_id !== decision.messageId);
  } else if (!state.pending.some((item) => item.message_id && item.message_id === decision.messageId)) {
    state.pending.push(payload);
  }
  save(state);
  return { ...decision, delivered: ok };
}
