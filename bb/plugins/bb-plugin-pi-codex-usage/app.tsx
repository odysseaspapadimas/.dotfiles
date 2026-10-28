import { useEffect, useState } from "react";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { Result, Target, rpcContract } from "./contract.ts";
import { isPiOpenAI, resetLabel, usageTarget } from "./selection.ts";
import { BesideModel } from "./placement.tsx";
import "./usage.css";

export function Usage({ target }: { target: Target }) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState(false);
  const [, tick] = useState(0);
  const [refreshKey, refresh] = useState(0);
  // Parent keys this component by target, so old machine/account data never flashes.
  const key = JSON.stringify(target);
  useEffect(() => {
    let active = true;
    let busy = false;
    const load = async (force = false) => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const next = await rpc.call("usage", { target: JSON.parse(key), refresh: force });
        if (active) { setResult(next); setError(false); }
      } catch { if (active) setError(true); }
      finally { busy = false; }
    };
    void load(refreshKey > 0);
    const poll = () => { tick(value => value + 1); void load(); };
    const timer = window.setInterval(poll, 60000);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", poll); document.removeEventListener("visibilitychange", poll); };
  }, [rpc, key, refreshKey]);
  const usage = result?.usage;
  // The longest window is the total allowance (weekly), matching the Pi footer.
  const windows = usage?.status === "ok" ? usage.windows : [];
  const quota = windows.find(item => /weekly|week/i.test(item.id + " " + item.label)) ?? windows.at(-1);
  const message = error ? "Could not refresh Codex usage. Click to retry." :
    !usage ? "Loading Codex usage…" :
    usage.status === "not_installed" ? "Install Codex on this machine." :
    usage.status === "unauthenticated" ? "Run codex login on this machine." :
    usage.status === "expired" ? "Codex login expired. Sign in again." :
    usage.status === "error" ? usage.message : !quota ? "No usage limits reported." : null;
  const percent = quota ? Number(quota.usedPercent.toFixed(1)) : null;
  const text = quota ? `${percent}%/${resetLabel(quota.resetsAt)}` : (usage || error ? "—" : "…");
  const details = [
    "Codex account usage — may differ from Pi’s OpenAI allowance.",
    usage?.status === "ok" ? [usage.accountEmail, usage.planLabel, result?.hostName].filter(Boolean).join(" · ") : "",
    quota ? `${quota.label}: ${percent}% used. Resets ${quota.resetsAt ? new Date(quota.resetsAt).toLocaleString() : "unknown"}.` : "",
    message,
    error && quota && result?.observedAt ? `Showing cached usage from ${new Date(result.observedAt).toLocaleString()}.` : "",
    "Click to refresh.",
  ].filter(Boolean).join("\n");
  return <button type="button" className="pi-codex-usage" title={details}
    aria-label={`Codex usage: ${text}. Click to refresh.`}
    onClick={() => refresh(value => value + 1)}>{text}</button>;
}
export function ComposerUsage() {
  const composer = useComposer();
  if (!isPiOpenAI(composer.selection)) return null;
  const target = usageTarget(composer.scope, composer.selection);
  if (!target) return null;
  return <BesideModel><Usage key={JSON.stringify(target)} target={target} /></BesideModel>;
}
export default definePluginApp(app => {
  app.composer.customize({
    id: "pi-codex-usage",
    actions: [{ id: "usage", component: ComposerUsage }],
  });
});
