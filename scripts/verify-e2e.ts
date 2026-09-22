import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { Journal, boxPrerequisites, evidenceArgument, loadProbeEnvironment, repoRoot, sha256 } from "./probe-support.js";
import { BoxWorkspace } from "../src/vercel-box.js";
import { reviewClient, assertReviewProvider } from "../src/vercel-review.js";
import { parseState } from "../src/vercel-state.js";

async function main() {
  loadProbeEnvironment();
  const missing = boxPrerequisites(); if (missing.length) throw new Error(`Missing ${missing.join(", ")}`);
  const expectedProvider = process.env.BOXMOUNT_EXPECT_REVIEW_PROVIDER || reviewClient(process.env)?.provider || "Box AI";
  assert.equal(reviewClient(process.env)?.provider || "Box AI", expectedProvider, "Configured review provider differs from required provider");
  const journal = await Journal.create(evidenceArgument(process.argv.slice(2)));
  const token = process.env.BOX_ACCESS_TOKEN!;
  const root = process.env.BOX_FOLDER_ID!;
  const name = `boxmount-demo-${journal.runId}`;
  await journal.event("folder-intent", { root, name });
  const response = await fetch("https://api.box.com/2.0/folders", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, parent: { id: root } }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Box folder creation failed: ${response.status}`);
  const { id: folderId } = await response.json() as { id: string };
  await journal.event("folder-created", { folderId });
  const statePath = resolve(journal.directory, "demo-state.json");
  const env: NodeJS.ProcessEnv = { ...process.env, SANDBOX_PROVIDER: "vercel", BOX_FOLDER_ID: folderId, BOXMOUNT_STATE_PATH: statePath, BOX_REVIEWER_USER_ID: "" };
  delete env.E2B_API_KEY;
  const command = (action: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("npm", ["run", action], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
    let output = ""; child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); }); child.stderr.on("data", (bytes: Buffer) => { output += bytes.toString(); });
    child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
  });
  const run = async (action: string) => {
    const result = await command(action);
    for (const secret of [token, process.env.VERCEL_TOKEN, process.env.OPENAI_API_KEY, process.env.AI_GATEWAY_API_KEY]) if (secret) result.output = result.output.replaceAll(secret, "[REDACTED]");
    await journal.event(action, { exitCode: result.code, output: result.output, sha256: sha256(result.output) });
    if (result.code !== 0) throw new Error(`${action} failed; see private evidence`);
    if (action === "demo") assertReviewProvider(result.output, expectedProvider);
  };
  let failure: unknown;
  try {
    for (const action of ["doctor", "seed", "demo", "status"]) await run(action);
  } catch (error) { failure = error; }
  try { await run("teardown"); } catch (error) { failure ??= error; }
  try {
    const state = parseState(await readFile(statePath)); assert.equal(state.phase, "complete");
    await new BoxWorkspace(token, folderId).verify(state.outputs);
    await journal.event("cleanup-audited", { phase: state.phase, files: state.outputs.length });
    if (!failure) { assert.equal(state.outputs.length, 1); await run("teardown"); }
  } catch (error) { failure ??= error; await journal.event("cleanup-audit-failed"); }
  await journal.write("result.json", { status: failure ? "failed" : "passed", folderId, scope: "vercel-full-demo", reviewProvider: expectedProvider, reviewerAssignment: false });
  if (failure) throw failure;
  console.log("E2E_PASS");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "E2E failed"); process.exitCode = 1; });
