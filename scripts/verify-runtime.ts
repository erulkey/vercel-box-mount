import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { credentials, errorRecord, evidenceArgument, Journal, loadProbeEnvironment, recoverOwnedSandbox, sha256 } from "./probe-support.js";

async function main(): Promise<void> {
  loadProbeEnvironment();
  const auth = credentials();
  const journal = await Journal.create(evidenceArgument(process.argv.slice(2)));
  const name = `boxmount-runtime-${journal.runId}`;
  await journal.event("intent", {
    scope: "vercel-runtime-only", name, sdk: "3.2.2", node: process.version,
    sourceSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    supportSha256: sha256(await readFile(new URL("./probe-support.ts", import.meta.url))),
    lockfileSha256: sha256(await readFile(new URL("../package-lock.json", import.meta.url))),
    boxMount: "NOT_TESTED", persistent: false, timeoutMs: 300_000,
  });
  let sandbox: Sandbox | undefined;
  let failure: unknown;
  let cleanup = "not-created";
  let createAttempted = false;
  let phase = "create";
  try {
    createAttempted = true;
    sandbox = await Sandbox.create({
      ...auth, name, image: "vercel/sandbox/universal", persistent: false,
      timeout: 300_000, resources: { vcpus: 2 },
      tags: { probe_run: journal.runId }, env: { BOXMOUNT_PROBE_MARKER: journal.runId },
      signal: AbortSignal.timeout(60_000),
    });
    const sessionId = sandbox.currentSession().sessionId;
    await journal.event("created", { name, sessionId, image: sandbox.image, status: sandbox.status, expiresAt: sandbox.expiresAt?.toISOString() });
    assert.equal(sandbox.persistent, false);
    phase = "commands";
    const command = async (label: string, cmd: string, args: string[], expected: number, timeoutMs = 20_000) => {
      const result = await sandbox!.runCommand({ cmd, args, timeoutMs, signal: AbortSignal.timeout(timeoutMs + 10_000) });
      const stdout = await result.stdout();
      const stderr = await result.stderr();
      await journal.event(label, { cmd, args, timeoutMs, exitCode: result.exitCode, stdout, stderr, stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) });
      assert.equal(result.exitCode, expected, label);
      return stdout;
    };
    await command("system", "sh", ["-c", "uname -m; cat /etc/os-release; id; command -v python3; command -v tar; command -v file; command -v readelf; getconf GNU_LIBC_VERSION"], 0);
    const bytes = Buffer.from(`synthetic-boxmount-runtime-${journal.runId}\n\u0000\u00ff`, "utf8");
    const path = "/vercel/sandbox/runtime-roundtrip.bin";
    await sandbox.writeFiles([{ path, content: bytes, mode: 0o600 }], { signal: AbortSignal.timeout(20_000) });
    const readback = await sandbox.readFileToBuffer({ path }, { signal: AbortSignal.timeout(20_000) });
    assert.ok(readback);
    assert.deepEqual(readback, bytes);
    await journal.event("upload-roundtrip", { path, bytes: bytes.length, sha256: sha256(bytes) });
    assert.equal((await command("environment", "printenv", ["BOXMOUNT_PROBE_MARKER"], 0)).trim(), journal.runId);
    await command("nonzero", "sh", ["-c", "printf expected-failure >&2; exit 23"], 23);
    phase = "timeout";
    const timed = await sandbox.runCommand({ cmd: "sh", args: ["-c", "echo $$ > /tmp/boxmount-timeout.pid; exec sleep 30"], timeoutMs: 1_000, signal: AbortSignal.timeout(15_000) });
    await journal.event("timeout-result", { timeoutMs: 1_000, exitCode: timed.exitCode, stdout: await timed.stdout(), stderr: await timed.stderr() });
    assert.notEqual(timed.exitCode, 0);
    await command("timeout-process-gone", "sh", ["-c", "pid=$(cat /tmp/boxmount-timeout.pid); if kill -0 \"$pid\" 2>/dev/null; then exit 1; fi"], 0);
    phase = "reconnect";
    sandbox = await Sandbox.get({ ...auth, name, resume: false, signal: AbortSignal.timeout(20_000) });
    assert.equal(sandbox.status, "running");
    assert.equal(sandbox.currentSession().sessionId, sessionId);
    await journal.event("reconnected", { name, sessionId, status: sandbox.status });
    phase = "stop";
    const stopped = await sandbox.stop({ signal: AbortSignal.timeout(40_000) });
    await journal.event("stopped", { snapshot: stopped.snapshot?.id ?? null });
    assert.equal(stopped.snapshot, undefined);
    for (let i = 0; i < 2; i++) {
      const read = await Sandbox.get({ ...auth, name, resume: false, signal: AbortSignal.timeout(20_000) });
      assert.equal(read.status, "stopped");
      assert.equal(read.currentSession().sessionId, sessionId);
      assert.equal(read.currentSnapshotId, undefined);
      await journal.event(`stopped-read-${i}`, { status: read.status, sessionId: read.currentSession().sessionId });
    }
    const sessions = await sandbox.listSessions({ signal: AbortSignal.timeout(20_000) });
    assert.equal((await sessions.toArray()).length, 1);
    const snapshots = await Snapshot.list({ ...auth, name, signal: AbortSignal.timeout(20_000) });
    assert.equal((await snapshots.toArray()).length, 0);
    await journal.event("no-extra-sessions-or-snapshots");
  } catch (error) {
    failure = error;
    await journal.event("failed", { phase, ...errorRecord(error) });
  } finally {
    try {
      // Creation may succeed remotely even when the client loses its response.
      if (!sandbox && createAttempted) {
        cleanup = "RECOVERY_REQUIRED";
        sandbox = await recoverOwnedSandbox(name, journal.runId, async () => {
          const found = await Sandbox.list({ ...auth, namePrefix: name, sortBy: "name", signal: AbortSignal.timeout(10_000) });
          if (!(await found.toArray()).some((item) => item.name === name)) return undefined;
          return Sandbox.get({ ...auth, name, resume: false, signal: AbortSignal.timeout(10_000) });
        });
      }
      if (sandbox) {
        assert.equal(sandbox.tags?.probe_run, journal.runId, "Refuse cleanup without ownership tag");
        await sandbox.stop({ signal: AbortSignal.timeout(40_000) });
        await journal.event("cleanup-stopped");
        await sandbox.delete({ signal: AbortSignal.timeout(30_000) });
        await journal.event("deleted", { name });
        const found = await Sandbox.list({ ...auth, namePrefix: name, sortBy: "name", signal: AbortSignal.timeout(20_000) });
        assert.ok(!(await found.toArray()).some((item) => item.name === name));
        cleanup = "deleted-and-absence-verified";
      }
    } catch (error) {
      cleanup = "RECOVERY_REQUIRED";
      failure ??= error;
      await journal.event("cleanup-failed", { name, ...errorRecord(error) });
    }
  }
  await journal.write("result.json", { status: failure ? "failed" : "passed", scope: "vercel-runtime-only", boxMount: "NOT_TESTED", cleanup, name });
  if (failure) throw new Error(`Runtime probe failed at ${phase}; cleanup=${cleanup}. See private evidence.`);
  console.log("RUNTIME_PASS (Box Mount NOT_TESTED)");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !("response" in error) ? error.message : "Runtime probe failed; inspect private evidence.");
  process.exitCode = 1;
});
