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

Grok routine 收到的 JSON 只有文字：`source`、`text`、`from_user_id`、`message_id`、`trigger_ms`。回复命令：

```bash
node /path/grokbot-wechat/bridge/reply.mjs "回复" --reply-to-ms <trigger_ms> --account <WECHAT_ACCOUNT_ID>
```

退出码 0 已交给 `openclaw message send --channel openclaw-weixin`。退出码 2 不是绑定的本人。退出码 4 表示这条回复对应的微信消息已经旧了，命令不会发送。

## 离线测试

```bash
node --test bridge/policy.test.mjs bridge/deliver.test.mjs
```

图片、视频、文件，以及没有转写的语音，官方插件会把正文变成 `[图片]`、`[视频]`、`[文件]`、`[语音]`。桥丢掉这些正文，不把文件路径发给 Grok。官方插件在进入钩子之前仍可能下载媒体，这一步不在本适配器里。
