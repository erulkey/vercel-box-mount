import type { VercelState } from "./vercel-state.js";
export async function requireSuccessfulUnmount(
  status: string,
  unmount: () => Promise<void>,
): Promise<void> {
  if (status.trim() === "No mount found.") {
    throw new Error("Mount is absent without a confirmed successful unmount; preserve recovery state and inspect retained local edits");
  }
  await unmount();
}

export async function finishComputeCleanup(steps: {
  verifyBox(): Promise<void>;
  stop(): Promise<void>;
  saveStopped(): Promise<void>;
  verifyStopped(): Promise<void>;
  delete(): Promise<void>;
  verifyAbsent(): Promise<void>;
  saveComplete(): Promise<void>;
}): Promise<void> {
  await steps.verifyBox();
  await steps.stop();
  await steps.saveStopped();
  await steps.verifyStopped();
  await steps.delete();
  await steps.verifyAbsent();
  await steps.verifyBox();
  await steps.saveComplete();
}
export async function inspectRunning<T>(status: string, inspect: () => Promise<T>): Promise<T | undefined> {
  if (status === "running") return inspect();
  return undefined;
}
export function selectProvider(action: string, requested: string | undefined, vercelActive: boolean, e2bActive: boolean): "vercel" | "e2b" {
  if (requested && requested !== "vercel" && requested !== "e2b") throw new Error("SANDBOX_PROVIDER must be e2b or vercel");
  if (["doctor", "seed", "demo"].includes(action) && (vercelActive || e2bActive)) throw new Error("An existing provider run is active; run status/teardown first");
  if (["status", "teardown"].includes(action)) {
    if (vercelActive && e2bActive) {
      if (!requested) throw new Error("Both provider states are active; select the intended provider explicitly");
      return requested as "vercel" | "e2b";
    }
    if (vercelActive) return "vercel";
    if (e2bActive) return "e2b";
  }
  return (requested || "e2b") as "vercel" | "e2b";
}

export function createWasRejected(status: number, state: VercelState): boolean {
  return [400, 401, 403, 422].includes(status) && state.phase === "creating" && !state.sessionId && state.unmounted && state.outputs.length === 0;
}
export function canCompleteAbsentRun(state: VercelState): boolean {
  return state.phase === "stopped" || (state.phase === "create-rejected" && !state.sessionId && state.unmounted && state.outputs.length === 0);
}
