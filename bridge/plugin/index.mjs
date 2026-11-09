import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { deliverInbound } from "../deliver.mjs";
import { claimsChannel } from "../policy.mjs";

export default definePluginEntry({
  id: "grok-wechat-bridge",
  name: "Grok WeChat bridge",
  description: "Claim WeChat dispatches and forward owner text to the Grok Bot webhook.",
  register(api) {
    api.on("before_dispatch", async (event, ctx) => {
      try {
        const decision = await deliverInbound({ event, ctx });
        if (claimsChannel(event?.channel || ctx?.channelId)) {
          const label = decision?.reason || decision?.action || "claimed";
          const delivered = decision?.delivered === true ? " delivered=yes" : decision?.delivered === false ? " delivered=no" : "";
          api.logger?.info?.(`grok-wechat-bridge ${label}${delivered}`);
        }
      } catch (error) {
        api.logger?.warn?.(`grok-wechat-bridge failed closed: ${error?.name || "Error"}`);
      }
      if (claimsChannel(event?.channel || ctx?.channelId)) return { handled: true };
    });
  },
});
