import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseState, saveState, type VercelState } from "../src/vercel-state.js";
const sample: VercelState = { provider: "vercel", name: "boxmount-demo-12345678-1234-1234-1234-123456789abc", runId: "12345678-1234-1234-1234-123456789abc", folderId: "1234", phase: "creating", unmounted: true, outputs: [] };
test("a competing create cannot replace another run's recovery state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "boxmount-state-")), "state.json");
  const results = await Promise.allSettled([saveState(path, sample, null), saveState(path, { ...sample, phase: "competing" }, null)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(["creating", "competing"].includes(parseState(await readFile(path)).phase));
});
test("stale updates preserve the newer recovery state", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "boxmount-state-")), "state.json");
  const initial = await saveState(path, sample, null);
  await saveState(path, { ...sample, phase: "mounted", unmounted: false }, initial);
  await assert.rejects(saveState(path, { ...sample, phase: "complete" }, initial), /State changed/);
  assert.equal(parseState(await readFile(path)).phase, "mounted");
});
test("state rejects foreign provider or mismatched owned name", () => {
  assert.throws(() => parseState(Buffer.from(JSON.stringify({ ...sample, provider: "e2b" }))));
  assert.throws(() => parseState(Buffer.from(JSON.stringify({ ...sample, name: "boxmount-demo-another-run" }))));
});
