import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChildEnv,
  formatAuthorizedKey,
  handleReplyRequest,
  parseEnvFile,
  parseReplyRequest,
  resolveReplyEnvPath,
} from "./reply-remote.mjs";
import { buildSshArgv, main as sshMain, planSshReply } from "./reply-ssh.mjs";

const OWNER = "o9cq809Labc@im.wechat";
const TOKEN = "gateway-token-should-not-leak";
const TEXT = "hello $(id); rm -rf / `uname`";

function request(overrides = {}) {
  return Buffer.from(JSON.stringify({
    v: 1,
    op: "reply",
    text: TEXT,
    trigger_ms: 5_000,
    from_user_id: OWNER,
    ...overrides,
  }));
}

const owner = { ok: true, ownerId: OWNER };
const fresh = { lastInboundMs: 4_000, seen: [], pending: [] };

test("malicious op, fields, and oversized input never spawn", () => {
  let calls = 0;
  const spawnImpl = () => {
    calls += 1;
    return { status: 0 };
  };
  assert.equal(handleReplyRequest(Buffer.from("{"), { spawnImpl }).reason, "invalid-json");
  assert.equal(handleReplyRequest(JSON.stringify({
    v: 1, op: "sh", text: "id", trigger_ms: 1, from_user_id: OWNER,
  }), { spawnImpl }).reason, "bad-op");
  assert.equal(parseReplyRequest(JSON.stringify({
    v: 1, op: "reply", text: "ok", trigger_ms: 1, from_user_id: OWNER, command: "id",
  })).error, "unknown-field");
  assert.equal(parseReplyRequest(Buffer.alloc(20_000, 0x61)).error, "too-large");
  assert.equal(parseReplyRequest(JSON.stringify({
    v: 1, op: "reply", text: "x".repeat(4001), trigger_ms: 1, from_user_id: OWNER,
  })).error, "bad-text");
  assert.equal(parseReplyRequest(JSON.stringify({
    v: 1, op: "reply", text: "ok", trigger_ms: "1", from_user_id: OWNER,
  })).error, "bad-trigger");
  assert.equal(calls, 0);
});

test("a stale trigger exits 4 before any send", () => {
  let calls = 0;
  const result = handleReplyRequest(request({ trigger_ms: 1_000 }), {
    owner,
    state: { lastInboundMs: 10_000, seen: [], pending: [] },
    spawnImpl: () => {
      calls += 1;
      return { status: 0 };
    },
  });
  assert.equal(result.code, 4);
  assert.equal(result.reason, "superseded");
  assert.equal(result.spawned, false);
  assert.equal(calls, 0);
});

test("a stranger is rejected and a matching reply is only an argv exec", () => {
  const stranger = handleReplyRequest(request({ from_user_id: "ffff9999@im.wechat" }), {
    owner,
    state: fresh,
    spawnImpl: () => { throw new Error("spawned"); },
  });
  assert.equal(stranger.code, 2);
  assert.equal(stranger.spawned, false);

  let seen;
  const ok = handleReplyRequest(request(), {
    owner,
    state: fresh,
    fileEnv: { PATH: "/usr/bin", OPENCLAW_GATEWAY_TOKEN: TOKEN, SSH_ORIGINAL_COMMAND: "rm -rf /" },
    spawnImpl: (bin, args, options) => {
      seen = { bin, args, options };
      return { status: 0, stdout: Buffer.from(TEXT), stderr: Buffer.from(TOKEN) };
    },
  });
  assert.equal(ok.code, 0);
  assert.equal(ok.reason, "sent");
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.timeout, 25_000);
  assert.equal(seen.args.at(-3), TEXT);
  assert.equal(seen.args.at(-1), "5000");
  assert.match(seen.args[0], /reply\.mjs$/);
  assert.equal(seen.options.env.OPENCLAW_GATEWAY_TOKEN, TOKEN);
  assert.equal("SSH_ORIGINAL_COMMAND" in seen.options.env, false);
  assert.equal(JSON.stringify(ok).includes(TEXT), false);
  assert.equal(JSON.stringify(ok).includes(TOKEN), false);
});

test("env files do not become shell and authorized_keys stays forced-command only", () => {
  assert.equal(parseEnvFile("PATH=/usr/bin\nOPENCLAW_GATEWAY_TOKEN=$(id)\n").error, "bad-env");
  assert.equal(buildChildEnv({ PATH: "/usr/bin", SSH_ORIGINAL_COMMAND: "id", OPENCLAW_GATEWAY_TOKEN: TOKEN }).SSH_ORIGINAL_COMMAND, undefined);
  const line = formatAuthorizedKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZvbyBiYXIgYmF6IGJhdA== grok-wechat-reply");
  assert.equal(line.line.startsWith("restrict,command=\"/usr/bin/node /var/lib/grok-wechat/app/bridge/reply-remote.mjs\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty "), true);
  assert.equal(formatAuthorizedKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZvbyBiYXIgYmF6IGJhdA== grok-wechat-reply", "/opt/grokwx/bin/grok-wechat-reply").line.includes("command=\"/opt/grokwx/bin/grok-wechat-reply\""), true);
  assert.equal(formatAuthorizedKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZvbyBiYXIgYmF6IGJhdA== grok-wechat-reply", "/tmp/evil;id").error, "bad-command");
  assert.equal(formatAuthorizedKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZvbyBiYXIgYmF6IGJhdA==\ncommand=\"sh\"").error, "bad-key");
  assert.equal(formatAuthorizedKey("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC grok").error, "bad-key");
});

test("wrapper install root is trusted and request fields cannot retarget it", () => {
  assert.equal(resolveReplyEnvPath({}).path, "/var/lib/grok-wechat/reply.env");
  assert.equal(resolveReplyEnvPath({ GROK_WECHAT_ROOT: "/opt/grokwx" }).path, "/opt/grokwx/reply.env");
  assert.equal(resolveReplyEnvPath({ GROK_WECHAT_REPLY_ENV: "/opt/grokwx/reply.env" }).path, "/opt/grokwx/reply.env");
  assert.equal(resolveReplyEnvPath({
    SSH_ORIGINAL_COMMAND: "GROK_WECHAT_ROOT=/tmp/evil",
  }).path, "/var/lib/grok-wechat/reply.env");
  assert.equal(resolveReplyEnvPath({ GROK_WECHAT_ROOT: "/opt/grokwx/../../tmp" }).error, "bad-env-path");
  assert.equal(parseReplyRequest(JSON.stringify({
    v: 1, op: "reply", text: "ok", trigger_ms: 1, from_user_id: OWNER,
    GROK_WECHAT_REPLY_ENV: "/tmp/evil/reply.env",
  })).error, "unknown-field");

  let seen;
  const result = handleReplyRequest(request(), {
    owner,
    state: fresh,
    processEnv: {
      OPENCLAW_STATE_DIR: "/tmp/evil/state",
      BRIDGE_DATA_DIR: "/tmp/evil/bridge-data",
      OPENCLAW_GATEWAY_TOKEN: "injected-token",
      SSH_ORIGINAL_COMMAND: "GROK_WECHAT_REPLY_ENV=/tmp/evil/reply.env",
    },
    fileEnv: {
      PATH: "/opt/grokwx/runtime/node/bin:/usr/bin:/bin",
      OPENCLAW_STATE_DIR: "/opt/grokwx/state",
      BRIDGE_DATA_DIR: "/opt/grokwx/bridge-data",
      OPENCLAW_GATEWAY_TOKEN: TOKEN,
    },
    spawnImpl: (_bin, _args, options) => {
      seen = options.env;
      return { status: 0 };
    },
  });
  assert.equal(result.code, 0);
  assert.equal(seen.OPENCLAW_STATE_DIR, "/opt/grokwx/state");
  assert.equal(seen.BRIDGE_DATA_DIR, "/opt/grokwx/bridge-data");
  assert.equal(seen.PATH.startsWith("/opt/grokwx/runtime/node/bin"), true);
  assert.equal(seen.OPENCLAW_GATEWAY_TOKEN, TOKEN);
  assert.equal(seen.SSH_ORIGINAL_COMMAND, undefined);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("the box ssh plan carries restrictions and not the reply text", () => {
  const env = {
    WECHAT_REPLY_SSH_HOST: "prod.example",
    WECHAT_REPLY_SSH_USER: "grok-wechat",
    WECHAT_REPLY_SSH_KEY: "/var/lib/grok-bot/wechat-reply/id_ed25519",
    WECHAT_REPLY_KNOWN_HOSTS: "/var/lib/grok-bot/wechat-reply/known_hosts",
  };
  const plan = planSshReply(["ping", "--reply-to-ms", "50", "--from-user-id", OWNER], env);
  assert.equal(plan.code, 0);
  const joined = plan.argv.join(" ");
  assert.equal(joined.includes("ping"), false);
  assert.match(joined, /ForwardAgent=no/);
  assert.match(joined, /ForwardX11=no/);
  assert.match(joined, /ClearAllForwardings=yes/);
  assert.match(joined, /RequestTTY=no/);
  assert.match(joined, /StrictHostKeyChecking=yes/);
  assert.equal(plan.argv.at(-1), "grok-wechat-reply");
  assert.equal(JSON.parse(plan.stdin.toString()).text, "ping");
  assert.equal(buildSshArgv({ ...env, WECHAT_REPLY_SSH_USER: "root" }).error, "bad-user");
  const printed = sshMain(["ping", "--reply-to-ms", "50", "--from-user-id", OWNER, "--print-argv"], env, () => {
    throw new Error("connected");
  });
  assert.equal(printed.reason, "print-argv");
});
