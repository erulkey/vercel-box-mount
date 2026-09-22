import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertOutsideRepository, boxPrerequisites, credentials, evidenceArgument, Journal, recoverOwnedSandbox, repoRoot } from "../scripts/probe-support.js";

test("partial explicit credentials cannot silently select another account", () => {
  assert.throws(() => credentials({ VERCEL_TOKEN: "test", VERCEL_OIDC_TOKEN: "also-test" }));
  assert.deepEqual(credentials({ VERCEL_OIDC_TOKEN: "test" }), {});
  assert.throws(() => credentials({}));
});

test("Box prerequisites reject reviewer notifications and the account root", () => {
  assert.throws(() => boxPrerequisites({ BOX_REVIEWER_USER_ID: "123" }));
  assert.throws(() => boxPrerequisites({ BOX_FOLDER_ID: "0" }));
  assert.deepEqual(boxPrerequisites({}), ["BOX_ACCESS_TOKEN", "BOX_FOLDER_ID", "BOX_MOUNT_ARCHIVE", "BOX_MOUNT_SETUP_DOCS"]);
});

test("evidence paths cannot target the repository or its descendants", () => {
  assert.throws(() => assertOutsideRepository(repoRoot, repoRoot));
  assert.throws(() => assertOutsideRepository(join(repoRoot, "results"), repoRoot));
  assert.doesNotThrow(() => assertOutsideRepository(`${repoRoot}-evidence`, repoRoot));
  assert.throws(() => evidenceArgument(["--evidence-dir", "relative"]));
});

test("journals preserve existing evidence and reject symlinks into the repository", async () => {
  const parent = await mkdtemp(join(tmpdir(), "boxmount-journal-test-"));
  try {
    const directory = join(parent, "run");
    const journal = await Journal.create(directory);
    await journal.write("result.json", { status: "original" });
    await assert.rejects(() => journal.write("result.json", { status: "replacement" }));
    await assert.rejects(() => Journal.create(directory));
    assert.equal(JSON.parse(await readFile(join(directory, "result.json"), "utf8")).status, "original");
    await symlink(repoRoot, join(parent, "repo-link"));
    await assert.rejects(() => Journal.create(join(parent, "repo-link", "unexpected-evidence")));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("lost create response recovers an owned sandbox that becomes visible later", async () => {
  const owned = { name: "synthetic-probe", tags: { probe_run: "synthetic-run" } };
  let visible = false;
  const recovered = await recoverOwnedSandbox(owned.name, "synthetic-run",
    async () => visible ? owned : undefined,
    async () => { visible = true; });
  assert.equal(recovered, owned);
});

test("persistent absence after ambiguous create cannot claim no resource exists", async () => {
  await assert.rejects(
    recoverOwnedSandbox("synthetic-probe", "synthetic-run", async () => undefined, async () => {}),
    /Creation remains uncertain/,
  );
});

test("recovery refuses unrelated resources and propagates lookup failures", async () => {
  for (const found of [
    { name: "different", tags: { probe_run: "synthetic-run" } },
    { name: "synthetic-probe", tags: { probe_run: "another-run" } },
  ]) {
    await assert.rejects(recoverOwnedSandbox("synthetic-probe", "synthetic-run", async () => found), /Refuse recovery/);
  }
  await assert.rejects(recoverOwnedSandbox("synthetic-probe", "synthetic-run", async () => { throw new Error("API unavailable"); }), /API unavailable/);
});
