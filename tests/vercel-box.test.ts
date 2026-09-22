import test from "node:test";
import assert from "node:assert/strict";
import { BoxWorkspace } from "../src/vercel-box.js";
import { digest } from "../src/vercel-state.js";
test("missing Box output times out instead of treating local output as synchronized", async () => {
  const fetcher: typeof fetch = async () => Response.json({ total_count: 0, entries: [] });
  const box = new BoxWorkspace("synthetic-token", "123", fetcher);
  await assert.rejects(box.verify([{ path: "review.md", sha256: digest("expected") }], 0), /did not synchronize/);
});
test("Box authentication failure cannot become an empty-success response", async () => {
  const box = new BoxWorkspace("synthetic-token", "123", async () => new Response("", { status: 401 }));
  await assert.rejects(box.verify([{ path: "review.md", sha256: digest("expected") }], 0), /HTTP 401/);
});
test("a stale Box file does not pass the expected review hash", async () => {
  const fetcher: typeof fetch = async (url) => String(url).includes("/items")
    ? Response.json({ total_count: 1, entries: [{ id: "456", name: "review.md", type: "file" }] }) : new Response("stale review");
  await assert.rejects(new BoxWorkspace("synthetic-token", "123", fetcher).verify([{ path: "review.md", sha256: digest("fresh review") }], 0), /did not synchronize/);
});
