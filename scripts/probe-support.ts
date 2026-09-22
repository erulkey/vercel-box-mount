import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError } from "@vercel/sandbox";
import { config as loadDotenv } from "dotenv";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export function loadProbeEnvironment(): void {
  if (process.env.BOXMOUNT_ENV_FILE) {
    loadDotenv({ path: process.env.BOXMOUNT_ENV_FILE, quiet: true, override: false });
  }
}

export function credentials(env: NodeJS.ProcessEnv = process.env) {
  const names = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"] as const;
  const values = names.map((name) => env[name]?.trim());
  if (values.some(Boolean)) {
    if (!values.every(Boolean)) throw new Error("Provide all three Vercel access-token settings.");
    return { token: values[0]!, teamId: values[1]!, projectId: values[2]! };
  }
  if (!env.VERCEL_OIDC_TOKEN?.trim()) throw new Error("Vercel credentials are missing.");
  return {};
}

export function evidenceArgument(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--evidence-dir" || !isAbsolute(args[1]!)) {
    throw new Error("Usage: --evidence-dir /absolute/path/to/new-private-directory");
  }
  return args[1]!;
}

export function assertOutsideRepository(path: string, repository: string): void {
  const part = relative(repository, path);
  if (part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))) {
    throw new Error("Evidence must be outside the contribution repository.");
  }
}

export function errorRecord(error: unknown): Record<string, unknown> {
  if (error instanceof APIError) return { kind: "vercel-api-error", status: error.response.status };
  return { kind: error instanceof Error ? error.name : "unknown-error" };
}

export function boxPrerequisites(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing = ["BOX_ACCESS_TOKEN", "BOX_FOLDER_ID", "BOX_MOUNT_ARCHIVE", "BOX_MOUNT_SETUP_DOCS"]
    .filter((name) => !env[name]?.trim());
  if (env.BOX_REVIEWER_USER_ID?.trim()) throw new Error("Box reviewer assignment must be disabled.");
  if (env.BOX_FOLDER_ID?.trim() === "0") throw new Error("The Box account root cannot be a test folder.");
  return missing;
}

export async function recoverOwnedSandbox<T extends { name: string; tags?: Record<string, string> }>(
  name: string,
  runId: string,
  lookup: () => Promise<T | undefined>,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const found = await lookup();
    if (found) {
      if (found.name !== name || found.tags?.probe_run !== runId) {
        throw new Error("Refuse recovery without matching name and ownership tag.");
      }
      return found;
    }
    if (attempt < 4) await wait();
  }
  throw new Error("Creation remains uncertain; retain the sandbox name for recovery.");
}

export class Journal {
  private sequence = 0;
  private constructor(readonly directory: string, readonly runId: string) {}

  static async create(directory: string): Promise<Journal> {
    assertOutsideRepository(resolve(directory), repoRoot);
    const parent = await realpath(dirname(directory));
    const canonical = resolve(parent, relative(dirname(directory), directory));
    assertOutsideRepository(canonical, await realpath(repoRoot));
    await mkdir(canonical, { mode: 0o700 });
    return new Journal(canonical, randomUUID());
  }

  async write(name: string, record: Record<string, unknown>): Promise<void> {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Invalid evidence filename.");
    const path = resolve(this.directory, name);
    const lock = await open(`${path}.lock`, "wx", 0o600);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      try {
        await readFile(path);
        throw new Error("Evidence already exists; refusing to overwrite.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const bytes = JSON.stringify({ at: new Date().toISOString(), runId: this.runId, ...record }, null, 2) + "\n";
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      const receipt = await open(`${path}.receipt`, "wx", 0o600);
      try {
        await receipt.writeFile(JSON.stringify({ target: name, actor: "compatibility-probe", reason: "Record observed probe evidence", pre_edit_sha256: "MISSING", post_edit_sha256: sha256(bytes), at: new Date().toISOString(), result: "WRITE_COMMITTED" }) + "\n");
        await receipt.sync();
      } finally { await receipt.close(); }
    } finally {
      await lock.close();
      await unlink(`${path}.lock`);
    }
  }

  async event(stage: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.write(`${String(++this.sequence).padStart(3, "0")}-${stage}.json`, { stage, ...data });
  }
}
