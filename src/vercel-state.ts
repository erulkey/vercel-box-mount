import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type VercelState = {
  scope?: { teamId: string; projectId: string };
  provider: "vercel"; name: string; runId: string; folderId: string; phase: string;
  sessionId?: string; expiresAt?: string; unmounted: boolean;
  outputs: { path: string; sha256: string }[];
};
export const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export async function stateBytes(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function saveState(path: string, state: VercelState, expected: Buffer | null): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await open(`${path}.lock`, "wx", 0o600);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const current = await stateBytes(path);
    if ((current ? digest(current) : null) !== (expected ? digest(expected) : null)) throw new Error("State changed in another process; refusing overwrite");
    const bytes = Buffer.from(JSON.stringify(state, null, 2) + "\n");
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const receipt = await open(`${path}.${randomUUID()}.receipt`, "wx", 0o600);
    try { await receipt.writeFile(JSON.stringify({ pre_edit_sha256: current ? digest(current) : "MISSING", post_edit_sha256: digest(bytes), at: new Date().toISOString(), result: "WRITE_COMMITTED" })); } finally { await receipt.close(); }
    return bytes;
  } finally { await lock.close(); await unlink(`${path}.lock`); }
}
export function parseState(bytes: Buffer): VercelState {
  const state = JSON.parse(bytes.toString()) as VercelState;
  if (state.provider !== "vercel" || !/^boxmount-demo-[0-9a-f-]{36}$/.test(state.name) || state.name !== `boxmount-demo-${state.runId}` || !/^\d+$/.test(state.folderId) || !Array.isArray(state.outputs)) throw new Error("Invalid Vercel recovery state");
  return state;
}
