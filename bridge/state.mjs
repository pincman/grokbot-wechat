import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAccountFile, ownerIdFromAccount, resolveOwner } from "./policy.mjs";

export function stateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

export function bridgeDir() {
  return process.env.BRIDGE_DATA_DIR || path.join(stateDir(), "grok-wechat-bridge");
}

export function accountDir() {
  return path.join(stateDir(), "openclaw-weixin", "accounts");
}

export function listAccountFiles(dir = accountDir()) {
  try {
    return fs.readdirSync(dir).filter(isAccountFile);
  } catch {
    return [];
  }
}

export function readScannedOwner(dir = accountDir(), accountId = process.env.WECHAT_ACCOUNT_ID) {
  const files = listAccountFiles(dir);
  const wanted = accountId ? `${accountId}.json` : "";
  const chosen = wanted ? files.filter((name) => name === wanted) : files;
  if (chosen.length !== 1) return { accountCount: files.length, userId: "" };
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, chosen[0]), "utf8"));
  } catch {
    return { accountCount: files.length, userId: "" };
  }
  return { accountCount: files.length, userId: ownerIdFromAccount(data), accountFile: chosen[0] };
}

export function resolveBoundOwner() {
  const scanned = readScannedOwner();
  return resolveOwner({
    envOwner: process.env.WECHAT_OWNER_ID,
    scannedOwner: scanned.userId,
    accountCount: scanned.accountCount,
  });
}

function statePath() {
  return path.join(bridgeDir(), "state.json");
}

export function loadBridgeState() {
  try {
    const data = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    return {
      seen: Array.isArray(data.seen) ? data.seen : [],
      pending: Array.isArray(data.pending) ? data.pending : [],
      lastInboundMs: Number(data.lastInboundMs) || 0,
      lastDecision: typeof data.lastDecision === "string" ? data.lastDecision : "",
    };
  } catch {
    return { seen: [], pending: [], lastInboundMs: 0, lastDecision: "" };
  }
}

export function saveBridgeState(state) {
  const dir = bridgeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = statePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    seen: state.seen.slice(-500),
    pending: state.pending,
    lastInboundMs: state.lastInboundMs || 0,
    lastDecision: state.lastDecision || "",
  }));
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
