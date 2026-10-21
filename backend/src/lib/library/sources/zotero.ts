import { fromCslJson, type CslItem } from "../csl.js";
import { requestJson, sharedLimiter, SourceError, userAgent, type RateLimiter } from "../http.js";
import { normalizeArxivId } from "../normalize.js";
import type { PaperRecord } from "../types.js";
import { trimSlash, type SourceOptions } from "./common.js";
import { ZOTERO_TYPES } from "../zotero-rdf.js";

// Zotero Web API v3. https://www.zotero.org/support/dev/web_api/v3/basics
// Incremental sync: pass the `Last-Modified-Version` of the previous run as `since`.

export interface ZoteroOptions extends SourceOptions {
  apiKey: string;
}

export interface ZoteroLibraryRef {
  type: "user" | "group";
  id: string | number;
}

export interface ZoteroItem {
  key: string;
  version: number;
  itemType: string;
  record: PaperRecord;
}

export interface ZoteroKeyInfo {
  userId: number;
  username?: string;
  canReadUserLibrary: boolean;
  groups: { id: number; name: string }[];
}

interface ApiItem {
  key: string;
  version: number;
  data?: { itemType?: string; archiveID?: string; extra?: string; tags?: { tag: string }[]; DOI?: string };
  csljson?: CslItem;
}

export class ZoteroClient {
  readonly source = "zotero" as const;
  private base: string;
  private limiter: RateLimiter;

  constructor(private opts: ZoteroOptions) {
    this.base = trimSlash(opts.baseUrl ?? "https://api.zotero.org");
    this.limiter = opts.limiter ?? sharedLimiter("zotero");
  }

  private get<T>(path: string, params: Record<string, string | undefined> = {}, signal?: AbortSignal) {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return requestJson<T>(u.toString(), {
      source: "zotero",
      limiter: this.limiter,
      headers: { "Zotero-API-Key": this.opts.apiKey, "Zotero-API-Version": "3", "user-agent": userAgent(this.opts.contactEmail) },
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      signal,
    });
  }

  /** Check the key and list the libraries it can read. */
  async verifyKey(signal?: AbortSignal): Promise<ZoteroKeyInfo> {
    const { data } = await this.get<{ userID?: number; username?: string; access?: { user?: { library?: boolean } } }>("/keys/current", {}, signal);
    if (!data?.userID) throw new SourceError("zotero", 403, "Zotero API key 無效");
    const groups = await this.get<{ id: number; data?: { name?: string } }[]>(`/users/${data.userID}/groups`, {}, signal);
    return {
      userId: data.userID,
      username: data.username,
      canReadUserLibrary: !!data.access?.user?.library,
      groups: (groups.data ?? []).map((g) => ({ id: g.id, name: g.data?.name ?? String(g.id) })),
    };
  }

  private prefix(lib: ZoteroLibraryRef): string {
    return `/${lib.type === "group" ? "groups" : "users"}/${encodeURIComponent(String(lib.id))}`;
  }

  /**
   * Top-level items (attachments/notes excluded), all pages. Returns the library version to store for the next `since`.
   */
  async listItems(
    lib: ZoteroLibraryRef,
    opts: { since?: number; collectionKey?: string; max?: number; signal?: AbortSignal } = {},
  ): Promise<{ items: ZoteroItem[]; libraryVersion?: number; total?: number }> {
    const path = `${this.prefix(lib)}${opts.collectionKey ? `/collections/${encodeURIComponent(opts.collectionKey)}` : ""}/items/top`;
    const items: ZoteroItem[] = [];
    let libraryVersion: number | undefined;
    let total: number | undefined;
    const max = opts.max ?? 10_000;
    for (let start = 0; start < max; start += 100) {
      const res = await this.get<ApiItem[]>(
        path,
        { format: "json", include: "data,csljson", limit: "100", start: String(start), since: opts.since != null ? String(opts.since) : undefined },
        opts.signal,
      );
      if (res.status === 404) throw new SourceError("zotero", 404, "找不到這個 Zotero 文獻庫");
      const v = Number(res.headers.get("last-modified-version"));
      if (Number.isFinite(v) && res.headers.has("last-modified-version")) libraryVersion = v;
      const t = Number(res.headers.get("total-results"));
      if (Number.isFinite(t) && res.headers.has("total-results")) total = t;
      const page = res.data ?? [];
      for (const it of page) {
        const itemType = it.data?.itemType ?? "";
        if (itemType === "attachment" || itemType === "note" || itemType === "annotation" || !it.csljson) continue;
        const record = fromCslJson(it.csljson);
        if (!record.title) continue;
        if (ZOTERO_TYPES[itemType]) record.type = ZOTERO_TYPES[itemType]!;
        const arxiv = normalizeArxivId(it.data?.archiveID) ?? normalizeArxivId(/arXiv:\s*\S+/i.exec(it.data?.extra ?? "")?.[0]);
        if (arxiv && !record.arxivId) record.arxivId = arxiv;
        const cite = /^Citation Key:\s*(\S+)/im.exec(it.data?.extra ?? "")?.[1];
        record.citeKey = cite ?? (record.citeKey && !record.citeKey.includes("/") ? record.citeKey : undefined);
        if (!record.citeKey) delete record.citeKey;
        const tags = (it.data?.tags ?? []).map((t) => t.tag).filter(Boolean);
        if (tags.length) record.keywords = [...new Set([...(record.keywords ?? []), ...tags])];
        items.push({ key: it.key, version: it.version, itemType, record });
      }
      if (page.length < 100 || (total !== undefined && start + 100 >= total)) break;
    }
    return { items, libraryVersion, total };
  }

  /** Keys of items deleted since `since` (for incremental sync). */
  async deletedSince(lib: ZoteroLibraryRef, since: number, signal?: AbortSignal): Promise<string[]> {
    const { data } = await this.get<{ items?: string[] }>(`${this.prefix(lib)}/deleted`, { since: String(since) }, signal);
    return data?.items ?? [];
  }

  async listCollections(lib: ZoteroLibraryRef, signal?: AbortSignal): Promise<{ key: string; name: string; parent?: string }[]> {
    const { data } = await this.get<{ key: string; data?: { name?: string; parentCollection?: string | false } }[]>(
      `${this.prefix(lib)}/collections`,
      { limit: "100" },
      signal,
    );
    return (data ?? []).map((c) => ({ key: c.key, name: c.data?.name ?? c.key, ...(c.data?.parentCollection ? { parent: c.data.parentCollection } : {}) }));
  }
}
