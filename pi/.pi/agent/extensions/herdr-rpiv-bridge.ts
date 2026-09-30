import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep RPIV's question state visible to Herdr without modifying its generated integration. */
export default function (pi: ExtensionAPI) {
  pi.events.on("rpiv:ask-user:blocked", (data: { active?: boolean } | undefined) => {
    pi.events.emit("herdr:blocked", {
      active: data?.active === true,
      label: "Needs input",
    });
  });
}
