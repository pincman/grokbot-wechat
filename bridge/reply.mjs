#!/usr/bin/env node
/**
 * Send one text reply through the official OpenClaw WeChat plugin.
 * Usage: node reply.mjs "text" [--reply-to-ms MS] [--account ID]
 * Exit 0 sent, 2 not the bound owner, 4 superseded, 1 send failed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSendArgv, decideReply, normalizeId } from "./policy.mjs";
import { loadBridgeState, resolveBoundOwner } from "./state.mjs";

export function parseReplyArgs(argv, env = process.env) {
  let replyToMs = null;
  let accountId = env.WECHAT_ACCOUNT_ID || "";
  const text = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--reply-to-ms") {
      replyToMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (item === "--account") {
      accountId = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (item.startsWith("--")) return { error: `unknown flag ${item}` };
    text.push(item);
  }
  return { text: text.join(" ").trim(), replyToMs, accountId };
}

export function planReply(argv, env = process.env, state = loadBridgeState(), owner = resolveBoundOwner()) {
  const parsed = parseReplyArgs(argv, env);
  if (parsed.error) return { code: 1, reason: parsed.error };
  if (!normalizeId(parsed.text)) return { code: 1, reason: "missing-text" };
  if (!owner.ok) return { code: 2, reason: owner.reason };
  const decision = decideReply({
    ownerId: owner.ownerId,
    replyToMs: Number.isFinite(parsed.replyToMs) ? parsed.replyToMs : null,
    lastInboundMs: state.lastInboundMs,
  });
  if (!decision.ok) return { code: decision.code, reason: decision.reason };
  return {
    code: 0,
    argv: buildSendArgv({
      openclawBin: env.OPENCLAW_BIN || "openclaw",
      accountId: parsed.accountId,
      target: decision.target,
      text: parsed.text,
    }),
  };
}

export function main(argv = process.argv.slice(2)) {
  const plan = planReply(argv);
  if (plan.code !== 0) {
    process.stderr.write(`${plan.reason}\n`);
    return plan.code;
  }
  const [bin, ...rest] = plan.argv;
  const child = spawnSync(bin, rest, { stdio: "inherit" });
  return child.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
