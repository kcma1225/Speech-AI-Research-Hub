import { describe, expect, it } from "vitest";
import { ArxivClient, CrossrefClient, createLibraryService } from "../src/lib/library/index.js";

// Hits the real arXiv and Crossref APIs lightly (≈5 requests). Run with LIBRARY_LIVE=1.
// arXiv requests go through the shared 1-per-3-seconds limiter.
const live = process.env.LIBRARY_LIVE === "1";
const email = process.env.LIBRARY_CONTACT_EMAIL ?? "speech-ai-hub@example.org";

describe.skipIf(!live)("live APIs", () => {
  it("arXiv: id lookup and title match", { timeout: 60_000 }, async () => {
    const c = new ArxivClient({ contactEmail: email });
    const r = await c.getById("2005.08100");
    expect(r).toMatchObject({ arxivId: "2005.08100", year: 2020, type: "article" });
    expect(r!.title).toMatch(/^Conformer: Convolution-augmented Transformer for Speech/);
    expect(r!.authors[0]).toMatchObject({ family: "Gulati" });
    const m = await c.matchTitle("Wav2vec-Switch: Contrastive Learning from Original-noisy Speech Pairs for Robust Speech Recognition");
    expect(m?.record.arxivId).toBe("2110.04934");
  });

  it("Crossref: DOI lookup and bibliographic search", { timeout: 60_000 }, async () => {
    const c = new CrossrefClient({ contactEmail: email });
    const r = await c.getByDoi("10.21437/Interspeech.2020-3015");
    expect(r).toMatchObject({ type: "paper-conference", year: 2020, venue: "Interspeech" });
    expect(r!.title).toMatch(/Conformer/);
    const rs = await c.search("conformer convolution-augmented transformer speech recognition", { limit: 3 });
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((x) => x.title && x.doi)).toBe(true);
  });

  it("service: search arXiv + Crossref (keyless sources skipped)", { timeout: 60_000 }, async () => {
    const svc = createLibraryService({ contactEmail: email });
    const res = await svc.searchPapers("wav2vec 2.0 self-supervised speech", { sources: ["arxiv", "crossref"], limit: 5 });
    expect(res.errors).toEqual([]);
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits.some((h) => h.sources.includes("arxiv"))).toBe(true);
  });
});
