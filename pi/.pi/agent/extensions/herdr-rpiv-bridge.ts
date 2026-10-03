import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep RPIV's question state visible to Herdr without modifying its generated integration. */
export default function (pi: ExtensionAPI) {
  pi.events.on("rpiv:ask-user:blocked", (data) => {
    pi.events.emit("herdr:blocked", {
      active: typeof data === "object" && data !== null && "active" in data && data.active === true,
      label: "Needs input",
    });
  });
}
