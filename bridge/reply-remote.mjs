#!/usr/bin/env node
/**
 * Prod forced-command entry. Reads one JSON object from stdin and, only for op "reply",
 * runs reply.mjs. The SSH client cannot choose the command, the target, or the environment.
 * Exit codes match reply.mjs: 0 sent, 2 not the owner, 4 superseded, 1 rejected or failed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalWeixinUserId, decideReply } from "./policy.mjs";
import { loadBridgeState, resolveBoundOwner } from "./state.mjs";

export const MAX_STDIN = 16 * 1024;
export const MAX_TEXT = 4000;
export const TIMEOUT_MS = 25_000;
export const REPLY_ENV_PATH = "/var/lib/grok-wechat/reply.env";
const ALLOWED_KEYS = new Set(["v", "op", "text", "trigger_ms", "from_user_id"]);
const CHILD_ENV_KEYS = [
  "PATH", "HOME", "USER", "LANG", "LC_ALL",
  "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "BRIDGE_DATA_DIR", "OPENCLAW_BIN",
  "WECHAT_ACCOUNT_ID", "WECHAT_OWNER_ID", "OPENCLAW_GATEWAY_TOKEN",
  "XDG_CONFIG_HOME", "NODE_PATH",
];

export function parseEnvFile(text) {
  const env = {};
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!/^[A-Z][A-Z0-9_]*=/.test(trimmed)) return { error: "bad-env" };
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (value.length >= 2 && (value[0] === "'" || value[0] === "\"") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    if (value.includes("$(") || value.includes("`") || value.includes("\u0000")) return { error: "bad-env" };
    env[key] = value;
  }
  return { env };
}

export function buildChildEnv(fileEnv) {
  const env = {};
  for (const key of CHILD_ENV_KEYS) {
    if (typeof fileEnv?.[key] === "string" && fileEnv[key] !== "") env[key] = fileEnv[key];
  }
  return env;
}

export function parseReplyRequest(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8");
  if (bytes.length > MAX_STDIN) return { error: "too-large" };
  let data;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { error: "invalid-json" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "invalid-json" };
  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.has(key)) return { error: "unknown-field" };
  }
  if (data.v !== 1 || data.op !== "reply") return { error: "bad-op" };
  if (typeof data.text !== "string" || data.text.length === 0 || data.text.length > MAX_TEXT || data.text.includes("\u0000")) {
    return { error: "bad-text" };
  }
  if (typeof data.trigger_ms !== "number" || !Number.isSafeInteger(data.trigger_ms) || data.trigger_ms < 0) {
    return { error: "bad-trigger" };
  }
  const fromUserId = canonicalWeixinUserId(data.from_user_id);
  if (!fromUserId) return { error: "bad-from" };
  return { ok: true, text: data.text, triggerMs: data.trigger_ms, fromUserId };
}

export function formatAuthorizedKey(publicKeyLine) {
  const key = String(publicKeyLine ?? "").trim();
  if (/[\r\n,]/.test(key) || key.includes("command=") || key.includes("restrict")) return { error: "bad-key" };
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [A-Za-z0-9@._:-]+)?$/.test(key)) return { error: "bad-key" };
  const command = "/usr/bin/node /var/lib/grok-wechat/app/bridge/reply-remote.mjs";
  return {
    line: `restrict,command="${command}",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ${key}`,
  };
}

function defaultSpawn(bin, args, options) {
  return spawnSync(bin, args, options);
}

export function handleReplyRequest(raw, opts = {}) {
  const parsed = parseReplyRequest(raw);
  if (!parsed.ok) return { code: 1, reason: parsed.error, spawned: false };
  const owner = opts.owner || resolveBoundOwner();
  if (!owner.ok || parsed.fromUserId !== owner.ownerId) {
    return { code: 2, reason: owner.ok ? "not-owner" : owner.reason, spawned: false };
  }
  const state = opts.state || loadBridgeState();
  const decision = decideReply({
    ownerId: owner.ownerId,
    replyToMs: parsed.triggerMs,
    lastInboundMs: state.lastInboundMs,
  });
  if (!decision.ok) return { code: decision.code, reason: decision.reason, spawned: false };
  if (opts.check) return { code: 0, reason: "would-send", spawned: false };
  const env = buildChildEnv(opts.fileEnv || {});
  const spawnImpl = opts.spawnImpl || defaultSpawn;
  const child = spawnImpl(process.execPath, [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "reply.mjs"),
    parsed.text,
    "--reply-to-ms",
    String(parsed.triggerMs),
  ], {
    env,
    shell: false,
    timeout: TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child?.error?.code === "ETIMEDOUT" || child?.signal) {
    return { code: 1, reason: "timeout", spawned: true };
  }
  const code = child?.status ?? 1;
  if (code === 0) return { code: 0, reason: "sent", spawned: true };
  if (code === 2) return { code: 2, reason: "not-owner", spawned: true };
  if (code === 4) return { code: 4, reason: "superseded", spawned: true };
  return { code: 1, reason: "send-failed", spawned: true };
}

export function loadFixedEnv(file = REPLY_ENV_PATH) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0) return { error: "bad-env" };
    return parseEnvFile(fs.readFileSync(file, "utf8"));
  } catch {
    return { error: "bad-env" };
  }
}

async function readStdin(max) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > max) return { error: "too-large" };
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks) };
}

async function main() {
  const check = process.argv.includes("--check");
  const input = await readStdin(MAX_STDIN);
  if (input.error) {
    process.stdout.write(`${JSON.stringify({ code: 1, reason: input.error })}\n`);
    return 1;
  }
  const loaded = loadFixedEnv();
  const result = handleReplyRequest(input.bytes, {
    check,
    fileEnv: loaded.env || {},
  });
  process.stdout.write(`${JSON.stringify({ code: result.code, reason: result.reason })}\n`);
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(await main());
}
