import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let startTime: number | null = null;

  pi.on("agent_start", async () => {
    startTime = Date.now();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (startTime === null) return;

    const elapsed = Date.now() - startTime;
    const elapsedFormatted = formatDuration(elapsed);

    const modelName = ctx.model?.id ?? ctx.model?.name ?? "unknown";

    ctx.ui.notify(`${modelName} • ${elapsedFormatted}`, "info");
    startTime = null;
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    const remainingSeconds = seconds % 60;
    return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }
  if (seconds >= 1) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${ms}ms`;
}
