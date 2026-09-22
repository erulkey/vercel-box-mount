import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError, Sandbox, Snapshot, type SandboxUser } from "@vercel/sandbox";
import { reviewContractWithBoxAi } from "./box.js";
import { requireSuccessfulUnmount, finishComputeCleanup, inspectRunning, createWasRejected, canCompleteAbsentRun } from "./vercel-lifecycle.js";
import { reviewClient } from "./vercel-review.js";
import { BoxWorkspace } from "./vercel-box.js";
import { digest, parseState, saveState, stateBytes, type VercelState } from "./vercel-state.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const mount = "/shared/boxworkspace";
const data = "/home/boxmount/.box-mount";
const binary = "/usr/local/bin/box-mount";
const reviewPath = "Reviewed/Acme-MSA-review.md";
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing ${name}`); return value; }
function auth() {
  const token = process.env.VERCEL_TOKEN?.trim(), teamId = process.env.VERCEL_TEAM_ID?.trim(), projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (token || teamId || projectId) {
    if (!token || !teamId || !projectId) throw new Error("Provide VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID together");
    return { token, teamId, projectId };
  }
  if (!process.env.VERCEL_OIDC_TOKEN) throw new Error("Vercel authentication is missing");
  return {};
}
async function fixtures(directory = resolve(root, "fixtures/box-workspace")): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await fixtures(path));
    else if (entry.isFile() && ![".gitkeep", ".DS_Store"].includes(entry.name)) found.push(path);
  }
  return found;
}
export async function runVercel(action: string): Promise<void> {
  if (process.env.BOX_REVIEWER_USER_ID?.trim()) throw new Error("Reviewer assignment must remain disabled for the Vercel example");
  const statePath = process.env.BOXMOUNT_STATE_PATH || resolve(root, ".vercel-demo-state.json");
  let previous = await stateBytes(statePath);
  let state: VercelState | undefined = previous ? parseState(previous) : undefined;
  const persist = async () => { previous = await saveState(statePath, state!, previous); };
  const log = (stage: string, info: Record<string, unknown> = {}) => console.log(JSON.stringify({ stage, at: new Date().toISOString(), ...info }));
  const credentials = auth();
  const scope = "teamId" in credentials ? { teamId: credentials.teamId!, projectId: credentials.projectId! } : (() => {
    const claims = JSON.parse(Buffer.from(required("VERCEL_OIDC_TOKEN").split(".")[1]!, "base64url").toString()) as { owner_id?: string; project_id?: string };
    if (!claims.owner_id || !claims.project_id) throw new Error("OIDC token must identify owner_id and project_id");
    return { teamId: claims.owner_id, projectId: claims.project_id };
  })();
  if (state?.scope && (state.scope.teamId !== scope.teamId || state.scope.projectId !== scope.projectId)) throw new Error("Vercel scope differs from saved recovery state");
  const token = required("BOX_ACCESS_TOKEN");
  const reviewApi = reviewClient(process.env);
  const redact = (text: string) => [token, process.env.VERCEL_TOKEN, process.env.OPENAI_API_KEY, process.env.AI_GATEWAY_API_KEY].reduce<string>((s, secret) => secret ? s.replaceAll(secret, "[REDACTED]") : s, text);
  let sandbox: Sandbox | undefined;
  const command = async (user: SandboxUser, cmd: string, args: string[], timeoutMs = 30_000, env?: Record<string, string>) => {
    const result = await user.runCommand({ cmd, args, timeoutMs, env, signal: AbortSignal.timeout(timeoutMs + 10_000) });
    const stdout = redact(await result.stdout()), stderr = redact(await result.stderr());
    if (result.exitCode !== 0) throw new Error(`${cmd} exited ${result.exitCode}: ${stdout}\n${stderr}`);
    return stdout;
  };
  const reconnect = async () => {
    assert.ok(state);
    const list = await Sandbox.list({ ...credentials, namePrefix: state.name, sortBy: "name", signal: AbortSignal.timeout(20_000) });
    if (!(await list.toArray()).some((item) => item.name === state!.name)) {
      if (canCompleteAbsentRun(state)) {
        await new BoxWorkspace(token, state.folderId).verify(state.outputs);
        state.phase = "complete"; await persist(); log("recovered-after-delete"); return;
      }
      throw new Error("Saved sandbox is absent; recovery state retained. Verify Box outputs before clearing it.");
    }
    sandbox = await Sandbox.get({ ...credentials, name: state.name, resume: false, signal: AbortSignal.timeout(20_000) });
    assert.equal(sandbox.tags?.boxmount_run, state.runId, "Sandbox ownership does not match saved state");
    if (state.sessionId) assert.equal(sandbox.currentSession().sessionId, state.sessionId, "Sandbox session changed");
  };
  const cleanup = async (workspace: BoxWorkspace) => {
    assert.ok(state && sandbox);
    if (!state.unmounted) {
      if (sandbox.status !== "running") throw new Error("Sandbox stopped before confirmed unmount; preserve recovery state");
      await sandbox.writeFiles([{ path: "/vercel/sandbox/box-config.refresh.json", content: JSON.stringify({ access_token: token, refresh_token: "" }), mode: 0o600 }], { signal: AbortSignal.timeout(20_000) });
      await command(sandbox.asUser("root"), "sh", ["-c", `install -o boxmount -g boxmount -m 600 /vercel/sandbox/box-config.refresh.json ${data}/box-config.json && rm /vercel/sandbox/box-config.refresh.json`]);
      await command(sandbox.asUser("root"), "find", [mount, "-type", "d", "-exec", "chmod", "-t", "--", "{}", "+"]);
      const status = await command(sandbox.asUser("boxmount"), binary, ["--data-path", data, "status"]);
      await requireSuccessfulUnmount(status, async () => { await command(sandbox!.asUser("boxmount"), binary, ["--data-path", data, "unmount", mount], 180_000); });
      state.unmounted = true;
      state.phase = "unmounted";
      await persist();
      log("unmounted");
    }
    let verified = 0;
    await finishComputeCleanup({
      verifyBox: async () => { await workspace.verify(state!.outputs); log(verified++ ? "box-hashes-verified-after-cleanup" : "box-hashes-verified-before-stop", { files: state!.outputs.length }); },
      stop: async () => { const result = await sandbox!.stop({ signal: AbortSignal.timeout(40_000) }); assert.equal(result.snapshot, undefined); log("stopped"); },
      saveStopped: async () => { state!.phase = "stopped"; await persist(); },
      verifyStopped: async () => {
        const observed = await Sandbox.get({ ...credentials, name: state!.name, resume: false, signal: AbortSignal.timeout(20_000) });
        assert.equal(observed.status, "stopped");
        assert.equal((await (await Snapshot.list({ ...credentials, name: state!.name, signal: AbortSignal.timeout(20_000) })).toArray()).length, 0);
      },
      delete: async () => { await sandbox!.delete({ signal: AbortSignal.timeout(30_000) }); },
      verifyAbsent: async () => {
        const remaining = await Sandbox.list({ ...credentials, namePrefix: state!.name, sortBy: "name", signal: AbortSignal.timeout(20_000) });
        assert.ok(!(await remaining.toArray()).some((item) => item.name === state!.name)); log("deleted-and-absence-verified");
      },
      saveComplete: async () => { state!.phase = "complete"; await persist(); },
    });
  };
  if (["status", "teardown"].includes(action)) {
    if (!state || state.phase === "complete") { console.log("No active Vercel demo. Previous evidence is retained."); return; }
    await reconnect();
    if (state.phase === "complete") return;
    if (action === "status") {
      log("status", { name: state.name, sessionId: sandbox!.currentSession().sessionId, status: sandbox!.status, expiresAt: state.expiresAt });
      if (!state.unmounted) await inspectRunning(sandbox!.status, async () => { console.log(await command(sandbox!.asUser("boxmount"), binary, ["--data-path", data, "status"])); });
      return;
    }
    await cleanup(new BoxWorkspace(token, state.folderId));
    return;
  }
  if (state && state.phase !== "complete") throw new Error("A Vercel run is active or needs recovery. Run status/teardown first.");
  const folderId = required("BOX_FOLDER_ID");
  if (!/^\d+$/.test(folderId) || folderId === "0") throw new Error("Use a dedicated Box folder, not the account root");
  const workspace = new BoxWorkspace(token, folderId);
  const items = await workspace.items();
  if (action === "seed" && items.length) throw new Error("Seed requires an empty dedicated Box folder");
  if (action === "demo" && !items.some((item) => item.type === "folder" && item.name === "Incoming")) throw new Error("Seed the synthetic workspace first");
  const archive = await readFile(required("BOX_MOUNT_ARCHIVE"));
  if (digest(archive) !== "e9504ff02012b1e5e36b23c8a766c37a02dc4a49f9f21e87e491aa926ef82c0b") throw new Error("Use the verified Box Mount 0.5.0 Linux x86_64 build; other builds require a compatibility probe");
  const runId = randomUUID();
  state = { provider: "vercel", scope, name: `boxmount-demo-${runId}`, runId, folderId, phase: "creating", unmounted: true, outputs: [] };
  await persist();
  try {
    sandbox = await Sandbox.create({ ...credentials, name: state.name, image: "vercel/sandbox/universal", persistent: false, timeout: 1_800_000, resources: { vcpus: 2 }, tags: { boxmount_run: runId }, signal: AbortSignal.timeout(60_000) });
    state.sessionId = sandbox.currentSession().sessionId;
    state.expiresAt = sandbox.expiresAt?.toISOString();
    state.phase = "installing"; await persist();
    log("created", { name: state.name, sessionId: state.sessionId, image: sandbox.image, expiresAt: state.expiresAt });
    const daemon = await sandbox.createUser("boxmount");
    const agent = await sandbox.createUser("boxagent");
    const group = await sandbox.createGroup("boxworkspace");
    assert.equal(group.sharedDir, mount);
    await daemon.addToGroup(group.groupname); await agent.addToGroup(group.groupname);
    await sandbox.addUserToGroup((await sandbox.getDefaultUser()).username, group.groupname);
    const rootUser = sandbox.asUser("root");
    await command(rootUser, "sh", ["-c", "command -v setfacl >/dev/null || (apt-get update -qq && apt-get install -y -qq acl)"], 180_000);
    await command(rootUser, "sh", ["-c", `mkdir -p ${data} && chown boxmount:boxmount ${data} && chmod 700 ${data} && chown boxmount:boxworkspace ${mount} && chmod 2770 ${mount} && setfacl -m g:boxworkspace:rwx -m d:g:boxworkspace:rwx ${mount}`]);
    await sandbox.writeFiles([
      { path: "/vercel/sandbox/box-mount.tar.gz", content: archive, mode: 0o600 },
      { path: "/vercel/sandbox/box-config.private.json", content: JSON.stringify({ access_token: token, refresh_token: "" }), mode: 0o600 },
    ], { signal: AbortSignal.timeout(30_000) });
    await command(rootUser, "sh", ["-c", `tar -xzf /vercel/sandbox/box-mount.tar.gz -C /usr/local/bin && chmod 755 ${binary} && install -o boxmount -g boxmount -m 600 /vercel/sandbox/box-config.private.json ${data}/box-config.json && rm /vercel/sandbox/box-config.private.json`]);
    log("binary-version", { version: (await command(daemon, binary, ["--version"])).trim(), archiveSha256: digest(archive) });
    await command(agent, "sh", ["-c", `test ! -r ${data}/box-config.json && test ! -r ${data} && test -z "$BOX_ACCESS_TOKEN" && test -w ${mount} && ! sudo -n true 2>/dev/null`]);
    log("credential-isolation-passed");
    if (action === "doctor") { await cleanup(workspace); console.log("DOCTOR_PASS"); return; }
    state.unmounted = false; state.phase = "mounting"; await persist();
    await command(daemon, binary, ["--data-path", data, "mount", mount, folderId], 180_000);
    state.phase = "mounted"; await persist(); log("mounted");
    if (action === "seed") {
      for (const local of await fixtures()) {
        const path = relative(resolve(root, "fixtures/box-workspace"), local).split("\\").join("/");
        const bytes = await readFile(local);
        state.outputs.push({ path, sha256: digest(bytes) }); await persist();
        await command(agent, "mkdir", ["-p", dirname(`${mount}/${path}`)]);
        await agent.writeFiles([{ path: "fixture-upload.bin", content: bytes, mode: 0o660 }]);
        await command(agent, "cp", [`${agent.homeDir}/fixture-upload.bin`, `${mount}/${path}`]);
      }
      await command(agent, "mkdir", ["-p", `${mount}/Reviewed`]);
      await workspace.verify(state.outputs);
      await cleanup(workspace); console.log("SEED_PASS"); return;
    }
    if (Date.now() + 300_000 > Date.parse(state.expiresAt!)) throw new Error("Insufficient session time remains to review and synchronize safely");
    for (const path of ["Incoming/Acme-MSA.docx", "Playbook/approved-contract-playbook.md"]) {
      const remote = await agent.readFileToBuffer({ path: `${mount}/${path}` });
      assert.ok(remote?.length, `Missing ${path} in mounted workspace`);
    }
    state.phase = "reviewing"; await persist();
    let review: string;
    if (reviewApi) {
      const { openAiRunner } = await import("./contract-agent.js");
      const runner = openAiRunner.replace("_AI-generated with OpenAI inside E2B. ", "_");
      await agent.writeFiles([
        { path: "review.mjs", content: runner },
        { path: "package.json", content: JSON.stringify({ private: true, type: "module", dependencies: { mammoth: "1.12.1" } }) },
      ]);
      await command(agent, "sh", ["-c", `cd ${quote(agent.homeDir)} && npm install --silent`], 180_000);
      await command(agent, "mkdir", ["-p", `${mount}/Reviewed`]);
      await command(agent, "node", [`${agent.homeDir}/review.mjs`, mount, `${agent.homeDir}/review-output.md`], 300_000, { OPENAI_API_KEY: reviewApi.key, OPENAI_BASE_URL: reviewApi.baseURL, OPENAI_MODEL: reviewApi.model });
      const bytes = await agent.readFileToBuffer({ path: `${agent.homeDir}/review-output.md` }); assert.ok(bytes?.length); review = bytes.toString();
      state.outputs = [{ path: reviewPath, sha256: digest(review) }]; await persist();
      await command(agent, "chmod", ["660", `${agent.homeDir}/review-output.md`]);
      await command(agent, "cp", [`${agent.homeDir}/review-output.md`, `${mount}/${reviewPath}`]);
    } else {
      review = await reviewContractWithBoxAi(token, folderId);
      review += "\n\nQualified legal review is required.\n";
      await command(agent, "mkdir", ["-p", `${mount}/Reviewed`]);
      state.outputs = [{ path: reviewPath, sha256: digest(review) }]; await persist();
      await agent.writeFiles([{ path: "review-output.md", content: review, mode: 0o660 }]);
      await command(agent, "cp", [`${agent.homeDir}/review-output.md`, `${mount}/${reviewPath}`]);
    }
    state.outputs = [{ path: reviewPath, sha256: digest(review) }]; await persist();
    await workspace.verify(state.outputs);
    state.phase = "ready"; await persist();
    log("review-synchronized", { provider: reviewApi?.provider || "Box AI", sha256: digest(review), folderId, path: reviewPath });
    console.log("DEMO_PASS. Run npm run status, then npm run teardown before the session expires.");
  } catch (error) {
    if (error instanceof APIError && createWasRejected(error.response.status, state)) {
      state.phase = "create-rejected"; await persist();
    }
    log("recovery-required", { name: state.name, phase: state.phase, statePath });
    throw new Error(redact(error instanceof Error ? error.message : "Vercel workflow failed"));
  }
}
