import { selectProvider } from "./vercel-lifecycle.js";
import { config } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
config({ path: process.env.BOXMOUNT_ENV_FILE || resolve(root, ".env"), quiet: true, override: false });
const action = process.argv[2];
if (!["doctor", "seed", "demo", "status", "teardown"].includes(action || "")) throw new Error("Use doctor, seed, demo, status, or teardown");
const vercelStatePath = process.env.BOXMOUNT_STATE_PATH || resolve(root, ".vercel-demo-state.json");
const savedVercel = existsSync(vercelStatePath) && JSON.parse(readFileSync(vercelStatePath, "utf8")).phase !== "complete";
const savedE2b = existsSync(resolve(root, ".demo-state.json"));
const provider = selectProvider(action!, process.env.SANDBOX_PROVIDER, savedVercel, savedE2b);
if (provider === "vercel") {
  const { runVercel } = await import("./vercel.js");
  await runVercel(action!).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Vercel workflow failed"); process.exitCode = 1; });
} else if (provider === "e2b") {
  await import(`./${action}.js`);
} else throw new Error("SANDBOX_PROVIDER must be e2b or vercel");
