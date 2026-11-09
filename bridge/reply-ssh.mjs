#!/usr/bin/env node
/**
 * Box-side caller. The WeChat text travels on stdin, never in the SSH argument list.
 * Usage: node reply-ssh.mjs "text" --reply-to-ms MS --from-user-id ID
 * Exit codes match the prod reply: 0 sent, 2 not owner, 4 superseded, 1 rejected or transport failed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalWeixinUserId } from "./policy.mjs";

const SSH_OPTIONS = [
  ["BatchMode", "yes"],
  ["IdentitiesOnly", "yes"],
  ["PreferredAuthentications", "publickey"],
  ["PasswordAuthentication", "no"],
  ["KbdInteractiveAuthentication", "no"],
  ["PubkeyAuthentication", "yes"],
  ["ForwardAgent", "no"],
  ["ForwardX11", "no"],
  ["ClearAllForwardings", "yes"],
  ["RequestTTY", "no"],
  ["PermitLocalCommand", "no"],
  ["StrictHostKeyChecking", "yes"],
  ["UpdateHostKeys", "no"],
  ["GlobalKnownHostsFile", "/dev/null"],
  ["ConnectTimeout", "10"],
];

export function parseCallerArgs(argv) {
  let replyToMs = null;
  let fromUserId = "";
  const text = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--reply-to-ms") {
      replyToMs = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (item === "--from-user-id") {
      fromUserId = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (item === "--print-argv") continue;
    if (item.startsWith("--")) return { error: "unknown-flag" };
    text.push(item);
  }
  const body = text.join(" ").trim();
  const from = canonicalWeixinUserId(fromUserId);
  if (!body || body.length > 4000 || body.includes("\u0000")) return { error: "bad-text" };
  if (!Number.isSafeInteger(replyToMs) || replyToMs < 0) return { error: "bad-trigger" };
  if (!from) return { error: "bad-from" };
  return { text: body, triggerMs: replyToMs, fromUserId: from };
}

export function buildReplyStdin(request) {
  return Buffer.from(JSON.stringify({
    v: 1,
    op: "reply",
    text: request.text,
    trigger_ms: request.triggerMs,
    from_user_id: request.fromUserId,
  }));
}

export function buildSshArgv(env = process.env) {
  const host = String(env.WECHAT_REPLY_SSH_HOST || "");
  const user = String(env.WECHAT_REPLY_SSH_USER || "grok-wechat");
  const key = String(env.WECHAT_REPLY_SSH_KEY || "");
  const knownHosts = String(env.WECHAT_REPLY_KNOWN_HOSTS || "");
  const port = String(env.WECHAT_REPLY_SSH_PORT || "22");
  if (user === "root" || !/^[a-z][a-z0-9-]{0,31}$/.test(user)) return { error: "bad-user" };
  if (!/^[A-Za-z0-9._-]{1,253}$/.test(host)) return { error: "bad-host" };
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return { error: "bad-port" };
  if (!key.startsWith("/") || /[\s"'`]/.test(key)) return { error: "bad-key" };
  if (!knownHosts.startsWith("/") || /[\s"'`]/.test(knownHosts)) return { error: "bad-known-hosts" };
  const argv = [env.SSH_BIN || "ssh", "-i", key, "-p", port];
  for (const [name, value] of SSH_OPTIONS) argv.push("-o", `${name}=${value}`);
  argv.push("-o", `UserKnownHostsFile=${knownHosts}`);
  argv.push(`${user}@${host}`, "grok-wechat-reply");
  return { argv };
}

export function planSshReply(argv, env = process.env) {
  const request = parseCallerArgs(argv);
  if (request.error) return { code: 1, reason: request.error };
  const ssh = buildSshArgv(env);
  if (ssh.error) return { code: 1, reason: ssh.error };
  const stdin = buildReplyStdin(request);
  if (ssh.argv.join("\0").includes(request.text)) return { code: 1, reason: "text-in-argv" };
  return { code: 0, argv: ssh.argv, stdin, reason: "ready" };
}

export function main(argv = process.argv.slice(2), env = process.env, spawnImpl = spawnSync) {
  const plan = planSshReply(argv, env);
  if (plan.code !== 0) return plan;
  if (argv.includes("--print-argv")) return { code: 0, reason: "print-argv", argv: plan.argv };
  const [bin, ...args] = plan.argv;
  const child = spawnImpl(bin, args, {
    input: plan.stdin,
    shell: false,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (child?.error?.code === "ETIMEDOUT" || child?.signal) return { code: 1, reason: "timeout" };
  const line = String(child?.stdout || "").split("\n").find((item) => item.startsWith("{")) || "";
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed.code === "number" && typeof parsed.reason === "string" && !parsed.reason.includes(plan.stdin.toString())) {
      return { code: parsed.code, reason: parsed.reason };
    }
  } catch {
    // Fall through to a generic transport failure. Do not echo ssh output.
  }
  return { code: 1, reason: "ssh-failed" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = main();
  if (result.reason === "print-argv") process.stdout.write(`${result.argv.join("\n")}\n`);
  else process.stdout.write(`${JSON.stringify({ code: result.code, reason: result.reason })}\n`);
  process.exit(result.code);
}
