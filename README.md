# grokbot-wechat

把已绑定的微信文字，交给现有 Grok Bot 的 Webhook routine。微信收发只走腾讯发布的 `@tencent-weixin/openclaw-weixin`，跑在它要求的 OpenClaw Gateway 里。本仓库的适配器在模型被调用前接管微信消息，自己不回答微信。

仓库里的 `bind.py`、`ilink.py`、`forward.py` 是旧的第三方客户端：它写死 `OpenClaw/2.4.9`，并自己请求 iLink。不要安装、不要运行。

## 主机上要有的官方组件

- Node.js 24.16+ 或 26
- `openclaw@2026.11.2`
- `@tencent-weixin/openclaw-weixin@2.4.10`

OpenClaw 需要有一个 agent id，`openclaw message send` 才能解析发送者。微信消息由本插件声明 `handled`，不会把正文交给这个 agent 的模型。插件没加载成功时，官方插件仍会把消息送进模型；那种情况下先停掉微信渠道。

## 安装

```bash
npm install -g openclaw@2026.11.2
openclaw plugins install @tencent-weixin/openclaw-weixin@2.4.10
openclaw plugins enable openclaw-weixin
openclaw plugins install --link /path/grokbot-wechat/bridge/plugin --force
openclaw plugins enable grok-wechat-bridge
```

在 OpenClaw 配置里打开这个插件，并允许它读取会话钩子：

```json
{
  "plugins": {
    "entries": {
      "grok-wechat-bridge": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

环境变量写在 Gateway 的环境里，不要写进仓库：

- `WECHAT_WEBHOOK_URL`：现有 Grok Bot routine 的 https Webhook
- `WECHAT_WEBHOOK_KEY`：该 Webhook 的 Bearer
- `WECHAT_OWNER_ID`：可选。不设时使用官方插件扫码保存的 `userId`。两边都有且不一致时，桥拒绝转发
- `WECHAT_ACCOUNT_ID`：官方插件账户多于一个时必填
- `OPENCLAW_STATE_DIR`：可选，默认 `~/.openclaw`
- `BRIDGE_DATA_DIR`：可选，默认 `$OPENCLAW_STATE_DIR/grok-wechat-bridge`
- `OPENCLAW_BIN`：可选，默认 `openclaw`

## 扫码和启动

```bash
openclaw channels login --channel openclaw-weixin
openclaw gateway restart
```

手机微信扫官方插件给出的二维码并确认。这是唯一需要人做的登录。Webhook 地址和 Bearer 仍要从电脑版 Grok Bot 抄进上面的环境变量，不要贴进聊天。

## 回复

Grok routine 收到 `text`、`from_user_id`、`trigger_ms`。box 不读自己的 state，只把这三项交给 prod：

```bash
node /path/grokbot-wechat/bridge/reply-ssh.mjs "回复" --reply-to-ms <trigger_ms> --from-user-id <from_user_id>
```

prod 用本机扫码 `userId` 核对 `from_user_id`，并用本机 `lastInboundMs` 判断 `trigger_ms`。退出码 0 表示 prod 已调用 `reply.mjs`。退出码 2 不是绑定的本人。退出码 4 表示回复已过时，prod 不会发送。远程请求不能指定发送目标或命令。

## 隔离的 prod 用户和自启

在 Debian 13 上单独建用户，不改现有业务服务。并行安装期间不要启动这个 Gateway，避免两个微信轮询。

```bash
sudo useradd --system --create-home --home-dir /var/lib/grok-wechat --shell /bin/bash grok-wechat
sudo passwd -l grok-wechat
sudo install -d -m 0700 -o grok-wechat -g grok-wechat \
  /var/lib/grok-wechat/app /var/lib/grok-wechat/.openclaw \
  /var/lib/grok-wechat/bridge-data /var/lib/grok-wechat/.ssh
sudo tar -xzf grokbot-wechat-official-bridge.tar.gz -C /var/lib/grok-wechat/app --strip-components=1
sudo chown -R grok-wechat:grok-wechat /var/lib/grok-wechat
sudo install -m 0600 -o grok-wechat -g grok-wechat /var/lib/grok-wechat/app/bridge/prod-reply.example.env /var/lib/grok-wechat/reply.env
sudo install -m 0600 -o grok-wechat -g grok-wechat /var/lib/grok-wechat/app/bridge/prod-reply.example.env /var/lib/grok-wechat/gateway.env
sudo cp /var/lib/grok-wechat/app/bridge/systemd/grok-wechat-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable grok-wechat-gateway.service
```

`reply.env` 与 `gateway.env` 只在服务器上填写。`OPENCLAW_GATEWAY_TOKEN` 留在这两个文件里，不传到 box，也不要贴进聊天。登录 shell 用 bash，是因为 OpenSSH 执行 forced command 时需要一个可执行的 shell。这个账号没有密码。确认没有另一个微信轮询之后再 `systemctl start`。不要同时跑仓库里的 `forward.py`。

## 单用途回复密钥

在 box 上新生成 ed25519 密钥，不要复制 Mac 登录私钥：

```bash
install -d -m 700 /var/lib/grok-bot/wechat-reply
ssh-keygen -t ed25519 -f /var/lib/grok-bot/wechat-reply/id_ed25519 -C grok-wechat-reply -N ""
```

公钥写入 prod 的 `/var/lib/grok-wechat/.ssh/authorized_keys`，权限 0600。下面的命令只接受一行 `ssh-ed25519` 公钥，并加上固定命令和转发限制：

```bash
node --input-type=module -e 'import { formatAuthorizedKey } from "./bridge/reply-remote.mjs"; import fs from "node:fs"; const line = formatAuthorizedKey(fs.readFileSync(0, "utf8")); if (line.error) process.exit(1); process.stdout.write(line.line + "\n");' \
  < /var/lib/grok-bot/wechat-reply/id_ed25519.pub
```

客户端传来的命令只会出现在 `SSH_ORIGINAL_COMMAND`。入口丢掉它，不执行。box 用 `bridge/reply-ssh.example.env` 里的变量名。`WECHAT_REPLY_SSH_USER` 不能是 root。不要给这把密钥打开 `AcceptEnv`。

先用现有管理渠道核对 prod 主机密钥指纹，再在 box 上写入专用 known_hosts：

```bash
ssh-keyscan -t ed25519 -p 22 prod.example > /var/lib/grok-bot/wechat-reply/known_hosts
```

如果管理员批准修改 sshd，可以把 `bridge/systemd/sshd-match-grok-wechat.conf` 放到 `sshd_config.d`。它只收紧 `grok-wechat`。没有这段配置时，`authorized_keys` 的 `restrict` 和 `command=` 仍然限制这把密钥。这不表示可以绕过现有 SSH 审批，也不要求关闭认证或给所有用户打开转发。

## 不发送微信的核对

```bash
node --test bridge/policy.test.mjs bridge/deliver.test.mjs bridge/reply-remote.test.mjs
```

prod 上 `--check` 只做本地判断，不调用 `openclaw message send`：

```bash
sudo -u grok-wechat env HOME=/var/lib/grok-wechat \
  OPENCLAW_STATE_DIR=/var/lib/grok-wechat/.openclaw \
  BRIDGE_DATA_DIR=/var/lib/grok-wechat/bridge-data \
  node /var/lib/grok-wechat/app/bridge/reply-remote.mjs --check <<'JSON'
{"v":1,"op":"reply","text":"ping","trigger_ms":1,"from_user_id":"ffff9999@im.wechat"}
JSON
```

期望退出码 2。`from_user_id` 等于扫码用户，且 `trigger_ms` 比 prod `state.json` 的 `lastInboundMs` 早 500 毫秒以上时，期望退出码 4。box 上先看参数、不连接：

```bash
node bridge/reply-ssh.mjs ping --reply-to-ms 1 --from-user-id "$OWNER" --print-argv
```

参数里应有 `RequestTTY=no`、`ClearAllForwardings=yes` 和固定远端命令 `grok-wechat-reply`，不能出现回复正文。

## 离线测试

```bash
node --test bridge/policy.test.mjs bridge/deliver.test.mjs bridge/reply-remote.test.mjs
```

图片、视频、文件，以及没有转写的语音，官方插件会把正文变成 `[图片]`、`[视频]`、`[文件]`、`[语音]`。桥丢掉这些正文，不把文件路径发给 Grok。官方插件在进入钩子之前仍可能下载媒体，这一步不在本适配器里。

OpenClaw 2026.11.2 的 `before_dispatch` 使用 `ctx.SenderId`。插件 2.4.10 不设置这个字段，只把发送者放进 `From` / `To` / `OriginatingTo`，钩子上下文里对应 `conversationId`。桥在没有显式 `senderId` 时使用这个私聊对端，且必须与扫码 `userId` 完全一致。显式发送者和对端不一致、群消息、或账户 id，都拒绝转发，并且仍然 `handled`，不进入模型。诊断日志只有原因码，不写 id、正文或 token。

已经进过钩子的旧消息不会重放。更新插件并重启 Gateway 之后，需要再发一条新消息。
