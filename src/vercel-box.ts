import { digest } from "./vercel-state.js";
type Item = { id: string; type: string; name: string };
export class BoxWorkspace {
  constructor(private token: string, readonly folderId: string, private fetcher: typeof fetch = fetch) {}
  private async request(path: string) {
    const response = await this.fetcher(`https://api.box.com/2.0${path}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Box request failed: HTTP ${response.status}`);
    return response;
  }
  async items(folderId = this.folderId): Promise<Item[]> {
    const all: Item[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await (await this.request(`/folders/${folderId}/items?limit=1000&offset=${offset}&fields=id,type,name`)).json() as { entries: Item[]; total_count: number };
      all.push(...page.entries);
      if (offset + page.entries.length >= page.total_count) return all;
      if (!page.entries.length) throw new Error("Box pagination made no progress");
    }
  }
  async file(path: string): Promise<Buffer | null> {
    const parts = path.split("/");
    let folder = this.folderId;
    for (let index = 0; index < parts.length; index++) {
      const expectedType = index === parts.length - 1 ? "file" : "folder";
      const item = (await this.items(folder)).find((item) => item.name === parts[index] && item.type === expectedType);
      if (!item) return null;
      if (expectedType === "file") return Buffer.from(await (await this.request(`/files/${item.id}/content`)).arrayBuffer());
      folder = item.id;
    }
    return null;
  }
  async verify(outputs: { path: string; sha256: string }[], timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (const expected of outputs) {
      while (true) {
        const bytes = await this.file(expected.path);
        if (bytes && digest(bytes) === expected.sha256) break;
        if (Date.now() >= deadline) throw new Error(`Box did not synchronize ${expected.path} before the deadline`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
