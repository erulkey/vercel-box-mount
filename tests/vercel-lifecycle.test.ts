import test from "node:test";
import assert from "node:assert/strict";
import { requireSuccessfulUnmount } from "../src/vercel-lifecycle.js";
test("a detached failed unmount cannot authorize compute cleanup", async () => {
  let cleanupAuthorized = false;
  await assert.rejects(async () => {
    await requireSuccessfulUnmount("No mount found.\n", async () => {});
    cleanupAuthorized = true;
  }, /without a confirmed successful unmount/);
  assert.equal(cleanupAuthorized, false);
});
test("failed unmount propagates and prevents cleanup authorization", async () => {
  let cleanupAuthorized = false;
  await assert.rejects(async () => {
    await requireSuccessfulUnmount("status=stopped", async () => { throw new Error("final sync failed"); });
    cleanupAuthorized = true;
  }, /final sync failed/);
  assert.equal(cleanupAuthorized, false);
});
test("successful final unmount permits subsequent cleanup", async () => {
  let called = false;
  await requireSuccessfulUnmount("status=running", async () => { called = true; });
  assert.equal(called, true);
});

import { finishComputeCleanup, inspectRunning, selectProvider } from "../src/vercel-lifecycle.js";
for (const fault of ["verifyBox", "stop", "delete", "verifyAbsent"]) {
  test(`${fault} failure preserves recovery instead of marking complete`, async () => {
    const calls: string[] = [];
    const step = (name: string) => async () => { calls.push(name); if (name === fault) throw new Error(name); };
    await assert.rejects(finishComputeCleanup({ verifyBox: step("verifyBox"), stop: step("stop"), saveStopped: step("saveStopped"), verifyStopped: step("verifyStopped"), delete: step("delete"), verifyAbsent: step("verifyAbsent"), saveComplete: step("saveComplete") }), new RegExp(fault));
    assert.ok(!calls.includes("saveComplete"));
    if (["verifyBox", "stop"].includes(fault)) assert.ok(!calls.includes("delete"));
    if (["delete", "verifyAbsent"].includes(fault)) assert.ok(calls.includes("saveStopped"));
  });
}
test("stopped status never invokes a command that could auto-resume compute", async () => {
  let commands = 0;
  await inspectRunning("stopped", async () => { commands++; });
  assert.equal(commands, 0);
  await inspectRunning("running", async () => { commands++; });
  assert.equal(commands, 1);
});
test("provider dispatch preserves legacy E2B and follows saved active state", () => {
  assert.equal(selectProvider("doctor", undefined, false, false), "e2b");
  assert.equal(selectProvider("doctor", "vercel", false, false), "vercel");
  assert.equal(selectProvider("teardown", "vercel", false, true), "e2b");
  assert.equal(selectProvider("status", "e2b", true, false), "vercel");
  assert.throws(() => selectProvider("demo", "vercel", false, true), /active/);
  assert.throws(() => selectProvider("teardown", undefined, true, true), /explicitly/);
  assert.equal(selectProvider("teardown", "vercel", true, true), "vercel");
});

import { createWasRejected, canCompleteAbsentRun } from "../src/vercel-lifecycle.js";
import type { VercelState } from "../src/vercel-state.js";
test("rejected create can recover only after absence; ambiguous create remains retained", () => {
  const state: VercelState = { provider: "vercel", name: "test", runId: "test", folderId: "1", phase: "creating", unmounted: true, outputs: [] };
  assert.equal(createWasRejected(403, state), true);
  assert.equal(createWasRejected(500, state), false);
  assert.equal(createWasRejected(409, state), false);
  assert.equal(canCompleteAbsentRun(state), false);
  assert.equal(canCompleteAbsentRun({ ...state, phase: "create-rejected" }), true);
  assert.equal(createWasRejected(403, { ...state, sessionId: "existing" }), false);
  assert.equal(canCompleteAbsentRun({ ...state, phase: "create-rejected", outputs: [{ path: "unsynced", sha256: "hash" }] }), false);
});
