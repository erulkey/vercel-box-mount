import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { boxPrerequisites, credentials, errorRecord, evidenceArgument, Journal, loadProbeEnvironment, recoverOwnedSandbox, sha256 } from "./probe-support.js";

type BoxItem = { id: string; type: string; name: string; file_version?: { id: string }; etag?: string };
type BoxList = { entries: BoxItem[]; total_count: number };

async function main(): Promise<void> {
  loadProbeEnvironment();
  const journal = await Journal.create(evidenceArgument(process.argv.slice(2)));
  const missing = boxPrerequisites();
  if (missing.length) {
    await journal.write("result.json", { status: "blocked", missing, cloudResourcesCreated: false });
    process.exitCode = 2;
    return;
  }
  const auth = credentials();
  const token = process.env.BOX_ACCESS_TOKEN!;
  const rootId = process.env.BOX_FOLDER_ID!;
  const name = `boxmount-sync-${journal.runId}`;
  const mount = "/vercel/sandbox/box-probe";
  const binary = "/vercel/sandbox/box-mount";
  const data = "/vercel/.box-mount-probe";
  const scrub = (text: string) => text.replaceAll(token, "[REDACTED]");
  let sandbox: Sandbox | undefined;
  let folderId: string | undefined;
  let attempted = false;
  let mountAttempted = false;
  let unmounted = false;
  let outputsVerified = true;
  let cleanup = "not-created";
  let failure: unknown;
  let phase = "prerequisites";
  let failurePhase: string | undefined;
  const outputs: { name: string; bytes: Buffer; id?: string }[] = [];
  const api = async (path: string, init: RequestInit = {}, upload = false): Promise<Response> => {
    const response = await fetch(`${upload ? "https://upload.box.com/api/2.0" : "https://api.box.com/2.0"}${path}`, {
      ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`Box HTTP ${response.status} for ${path.split("?")[0]}`);
    return response;
  };
  const items = async (id: string): Promise<BoxItem[]> => {
    const all: BoxItem[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await (await api(`/folders/${id}/items?limit=1000&offset=${offset}&fields=id,type,name,file_version,etag`)).json() as BoxList;
      all.push(...page.entries);
      if (offset + page.entries.length >= page.total_count) return all;
      if (!page.entries.length) throw new Error("Box pagination made no progress");
    }
  };
  const download = async (id: string) => Buffer.from(await (await api(`/files/${id}/content`)).arrayBuffer());
  const upload = async (filename: string, bytes: Buffer, previous?: BoxItem): Promise<BoxItem> => {
    const form = new FormData();
    form.append("attributes", JSON.stringify(previous ? { name: filename } : { name: filename, parent: { id: folderId } }));
    form.append("file", new Blob([new Uint8Array(bytes)]), filename);
    const result = await (await api(previous ? `/files/${previous.id}/content` : "/files/content", {
      method: "POST", body: form, headers: previous?.etag ? { "If-Match": previous.etag } : {},
    }, true)).json() as BoxList;
    assert.equal(result.entries.length, 1);
    return result.entries[0]!;
  };
  const poll = async (label: string, check: () => Promise<boolean>, timeoutMs = 150_000) => {
    const started = Date.now();
    do {
      if (await check()) { await journal.event(label, { elapsedMs: Date.now() - started }); return; }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } while (Date.now() - started < timeoutMs);
    throw new Error(`Timed out waiting for ${label}`);
  };
  const command = async (label: string, cmd: string, args: string[], timeoutMs = 30_000, env?: Record<string, string>) => {
    const result = await sandbox!.runCommand({ cmd, args, env, timeoutMs, signal: AbortSignal.timeout(timeoutMs + 10_000) });
    const stdout = scrub(await result.stdout());
    const stderr = scrub(await result.stderr());
    await journal.event(label, { cmd, args, exitCode: result.exitCode, stdout, stderr, stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) });
    if (result.exitCode !== 0) throw new Error(`${label} exited ${result.exitCode}`);
    return stdout;
  };
  const verifyOutputs = async (label: string) => {
    for (const output of outputs) {
      await poll(`${label}-${output.name}`, async () => {
        const item = (await items(folderId!)).find((i) => i.type === "file" && i.name === output.name);
        if (!item) return false;
        output.id = item.id;
        return (await download(item.id)).equals(output.bytes);
      });
      await journal.event("output-hash", { label, name: output.name, id: output.id, sha256: sha256(output.bytes) });
    }
    outputsVerified = true;
  };
  await journal.event("intent", {
    name, rootId, scope: "boxmount-sync", sdk: "3.2.2", node: process.version,
    sourceSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    supportSha256: sha256(await readFile(new URL("./probe-support.ts", import.meta.url))),
    lockfileSha256: sha256(await readFile(new URL("../package-lock.json", import.meta.url))),
    setupDocsSha256: sha256(await readFile(process.env.BOX_MOUNT_SETUP_DOCS!)),
    persistent: false, timeoutMs: 900_000, reviewerAssignment: false,
  });
  try {
    assert.match(rootId, /^\d+$/);
    assert.notEqual(rootId, "0");
    const rootItems = await items(rootId);
    if (rootItems.length && !rootItems.every((i) => i.type === "folder" && /^boxmount-(probe|demo)-[0-9a-f-]{36}$/.test(i.name))) {
      throw new Error("Test root contains unrelated content; refusing writes");
    }
    const archive = await readFile(process.env.BOX_MOUNT_ARCHIVE!);
    assert.equal(sha256(archive), "e9504ff02012b1e5e36b23c8a766c37a02dc4a49f9f21e87e491aa926ef82c0b", "Probe requires the verified Box Mount 0.5.0 x86_64 archive");
    await journal.event("archive", { bytes: archive.length, sha256: sha256(archive) });
    const folderName = `boxmount-probe-${journal.runId}`;
    await journal.event("folder-intent", { folderName, rootId });
    const folder = await (await api("/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: folderName, parent: { id: rootId } }) })).json() as BoxItem;
    folderId = folder.id;
    await journal.event("folder-created", { folderId, folderName });
    assert.equal((await items(folderId)).length, 0);
    const original = Buffer.from(`# Synthetic contract\nRun: ${journal.runId}\nPayment: net 30 days.\n`);
    const edited = Buffer.from(`# Synthetic contract\nRun: ${journal.runId}\nPayment: net 45 days. Box-side revision.\n`);
    const input = await upload("synthetic-contract.md", original);
    assert.ok((await download(input.id)).equals(original));
    await journal.event("input-uploaded", { id: input.id, version: input.file_version?.id, sha256: sha256(original) });
    phase = "create";
    attempted = true;
    sandbox = await Sandbox.create({ ...auth, name, image: "vercel/sandbox/universal", persistent: false, timeout: 900_000, resources: { vcpus: 2 }, tags: { probe_run: journal.runId }, signal: AbortSignal.timeout(60_000) });
    const sessionId = sandbox.currentSession().sessionId;
    await journal.event("created", { name, sessionId, image: sandbox.image, expiresAt: sandbox.expiresAt?.toISOString() });
    phase = "command-semantics";
    const nonzero = await sandbox.runCommand({ cmd: "sh", args: ["-c", "printf expected-failure >&2; exit 23"], timeoutMs: 10_000, signal: AbortSignal.timeout(20_000) });
    await journal.event("nonzero-command", { exitCode: nonzero.exitCode, stdout: await nonzero.stdout(), stderr: await nonzero.stderr() });
    assert.equal(nonzero.exitCode, 23);
    const timed = await sandbox.runCommand({ cmd: "sh", args: ["-c", "echo $$ > /tmp/boxmount-timeout.pid; exec sleep 30"], timeoutMs: 1000, signal: AbortSignal.timeout(15_000) });
    await journal.event("timeout-command", { exitCode: timed.exitCode, stdout: await timed.stdout(), stderr: await timed.stderr() });
    assert.notEqual(timed.exitCode, 0);
    await command("timeout-process-gone", "sh", ["-c", 'pid=$(cat /tmp/boxmount-timeout.pid); if kill -0 "$pid" 2>/dev/null; then exit 1; fi']);
    phase = "install";
    await sandbox.writeFiles([{ path: "/vercel/sandbox/box-mount.tar.gz", content: archive, mode: 0o600 }], { signal: AbortSignal.timeout(30_000) });
    await command("extract", "tar", ["-xzf", "/vercel/sandbox/box-mount.tar.gz", "-C", "/vercel/sandbox"]);
    await command("system", "sh", ["-c", "uname -m; id; getconf GNU_LIBC_VERSION; file /vercel/sandbox/box-mount; ldd /vercel/sandbox/box-mount"]);
    await command("version", binary, ["--version"]);
    await command("directories", "sh", ["-c", `mkdir -p ${mount} ${data} && chmod 700 ${data}`]);
    phase = "mount";
    mountAttempted = true;
    await command("mount", binary, ["--data-path", data, "mount", mount, folderId], 180_000, { BOX_ACCESS_TOKEN: token });
    await command("mounted-status", binary, ["--data-path", data, "status"]);
    phase = "box-to-sandbox";
    await poll("box-to-sandbox", async () => {
      const bytes = await sandbox!.readFileToBuffer({ path: `${mount}/synthetic-contract.md` }, { signal: AbortSignal.timeout(15_000) });
      return !!bytes?.equals(original);
    });
    const writeOutput = async (filename: string, bytes: Buffer) => {
      outputs.push({ name: filename, bytes });
      outputsVerified = false;
      await sandbox!.writeFiles([{ path: `${mount}/${filename}`, content: bytes, mode: 0o600 }], { signal: AbortSignal.timeout(20_000) });
      await journal.event("sandbox-write", { name: filename, sha256: sha256(bytes) });
    };
    phase = "sandbox-to-box";
    await writeOutput("sandbox-output.md", Buffer.from(`# Synthetic output\nRun: ${journal.runId}\nWritten inside Vercel Sandbox.\n`));
    await verifyOutputs("sandbox-to-box");
    phase = "box-edit";
    const current = (await items(folderId)).find((i) => i.id === input.id)!;
    const revision = await upload(input.name, edited, current);
    assert.notEqual(revision.file_version?.id, input.file_version?.id);
    await journal.event("box-revision", { id: revision.id, beforeVersion: input.file_version?.id, afterVersion: revision.file_version?.id, sha256: sha256(edited) });
    await poll("box-edit-to-running-sandbox", async () => {
      const bytes = await sandbox!.readFileToBuffer({ path: `${mount}/synthetic-contract.md` }, { signal: AbortSignal.timeout(15_000) });
      return !!bytes?.equals(edited);
    });
    const reconnected = await Sandbox.get({ ...auth, name, resume: false, signal: AbortSignal.timeout(20_000) });
    assert.equal(reconnected.currentSession().sessionId, sessionId);
    assert.equal(reconnected.status, "running");
    await journal.event("same-running-session", { sessionId });
    phase = "final-sync";
    await writeOutput("final-output.md", Buffer.from(`# Final synthetic output\nRun: ${journal.runId}\nWritten immediately before unmount.\n`));
    await command("unmount", binary, ["--data-path", data, "unmount", mount], 180_000, { BOX_ACCESS_TOKEN: token });
    unmounted = true;
    await command("unmounted-status", binary, ["--data-path", data, "status"]);
    await verifyOutputs("final-sync-before-cleanup");
  } catch (error) {
    failure = error;
    failurePhase = phase;
    await journal.event("failed", { phase, ...errorRecord(error), message: error instanceof Error ? scrub(error.message) : "unknown" });
  } finally {
    phase = "cleanup";
    try {
      if (!sandbox && attempted) {
        cleanup = "RECOVERY_REQUIRED";
        sandbox = await recoverOwnedSandbox(name, journal.runId, async () => {
          const list = await Sandbox.list({ ...auth, namePrefix: name, sortBy: "name", signal: AbortSignal.timeout(10_000) });
          if (!(await list.toArray()).some((s) => s.name === name)) return undefined;
          return Sandbox.get({ ...auth, name, resume: false, signal: AbortSignal.timeout(10_000) });
        });
      }
      if (sandbox) {
        cleanup = "RECOVERY_REQUIRED";
        assert.equal(sandbox.tags?.probe_run, journal.runId);
        if (mountAttempted && !unmounted) {
          await command("recovery-unmount", binary, ["--data-path", data, "unmount", mount], 180_000, { BOX_ACCESS_TOKEN: token });
          unmounted = true;
        }
        if (!outputsVerified) await verifyOutputs("recovery-final-sync");
        if (mountAttempted) assert.ok(unmounted && outputsVerified, "Refuse compute cleanup before final sync");
        const stopped = await sandbox.stop({ signal: AbortSignal.timeout(40_000) });
        assert.equal(stopped.snapshot, undefined);
        await journal.event("stopped-after-sync");
        const stoppedRead = await Sandbox.get({ ...auth, name, resume: false, signal: AbortSignal.timeout(20_000) });
        assert.equal(stoppedRead.status, "stopped");
        assert.equal((await (await Snapshot.list({ ...auth, name, signal: AbortSignal.timeout(20_000) })).toArray()).length, 0);
        await sandbox.delete({ signal: AbortSignal.timeout(30_000) });
        const list = await Sandbox.list({ ...auth, namePrefix: name, sortBy: "name", signal: AbortSignal.timeout(20_000) });
        assert.ok(!(await list.toArray()).some((s) => s.name === name));
        cleanup = "deleted-and-absence-verified";
        await journal.event("deleted", { name });
      }
    } catch (error) {
      failure ??= error;
      await journal.event("cleanup-failed", { name, message: error instanceof Error ? scrub(error.message) : "unknown" });
    }
  }
  if (!failure) {
    try { await verifyOutputs("box-persists-after-compute-cleanup"); }
    catch (error) { failure = error; await journal.event("post-cleanup-read-failed", errorRecord(error)); }
  }
  await journal.write("result.json", { status: failure ? "failed" : "passed", phase: failurePhase || phase, scope: "boxmount-sync", cleanup, name, folderId, unmounted, outputsVerified, fullDemo: "NOT_TESTED" });
  if (failure) throw new Error(`Compatibility probe failed at ${failurePhase || phase}; cleanup=${cleanup}. See private evidence.`);
  console.log("COMPATIBILITY_PASS (full demo NOT_TESTED)");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !("response" in error) ? error.message : "Compatibility probe failed; inspect private evidence.");
  process.exitCode = 1;
});
