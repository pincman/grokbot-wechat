import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { deliverInbound } from "../deliver.mjs";

export default definePluginEntry({
  id: "grok-wechat-bridge",
  name: "Grok WeChat bridge",
  description: "Claim WeChat dispatches and forward owner text to the Grok Bot webhook.",
  register(api) {
    api.on("before_dispatch", async (event, ctx) => {
      try {
        await deliverInbound({
          channel: event?.channel || ctx?.channelId,
          senderId: event?.senderId || ctx?.senderId,
          body: event?.body || event?.content || "",
          messageId: event?.messageId || ctx?.messageId,
          timestamp: event?.timestamp,
        });
      } catch (error) {
        api.logger?.warn?.(`grok-wechat-bridge failed closed: ${error?.name || "Error"}`);
      }
      const channel = event?.channel || ctx?.channelId;
      if (channel === "openclaw-weixin" || channel === "weixin" || channel === "wechat") {
        return { handled: true };
      }
    });
  },
});
