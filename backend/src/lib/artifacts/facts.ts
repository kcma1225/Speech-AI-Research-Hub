/**
 * Bibliographic claims need a source (docs/architecture.md "Artifact edit gate" → facts; harness survey: claims tied to
 * the record they come from). What an artifact says about where its paper was published is compared with the library
 * record and how far it was verified (lib/library/published.ts): production 61666f10 wrote 「發表於 arXiv，並不是會議論文」
 * about an Interspeech 2024 paper because the library only knew the preprint.
 *
 * - 「不是會議論文／only a preprint」 is never a claim the record can support: a published record contradicts it, a
 *   preprint-only record only says 「目前只查到 arXiv 預印本紀錄」.
 * - A sentence about THIS paper (「這篇／本論文／this paper」, its title, its first author) naming a venue / year the
 *   record does not have is a mismatch; other papers' venues (「CLAS（Pundak, SLT 2018）」) are not checked.
 */
import { VENUES } from "../library/normalize.js";
import { CHECKS } from "../../workflows/checks.js";

export type BibFacts = { venue: string | null; year: number | null; preprint: boolean; title?: string | null; first_author?: string | null };

const NEG_RE = /(?:並?不是|並非|不屬於|非)(?:一篇)?(?:正式的?)?(?:會議|研討會|期刊)(?:論文|發表)|沒有(?:正式)?(?:發表|刊登)(?:在|於)?(?:任何)?(?:會議|期刊)|(?:只是|僅為|只有|仍是)(?:一篇)?\s*(?:arXiv\s*)?(?:預印本|preprint)|\bnot\s+(?:a\s+)?(?:conference|peer[- ]reviewed|journal)\s+paper\b|\bonly\s+(?:an?\s+)?(?:arXiv\s+)?preprint\b|\bunpublished\b/i;
const SELF_RE = /這篇|本篇|本論文|本文|該論文|這份論文|this (?:paper|work)|the paper\b|our paper/i;
const PUBLISHED_RE = /發表|刊登|收錄|接受|會議|期刊|出處|venue|published|appeared|accepted|proceedings/i;

const sentences = (text: string) => text.replace(/\r\n/g, "\n").split(/(?<=[。！？!?；;])|\n+|(?<=\.)(?<!\b(?:et al|e\.g|i\.e|Fig|Eq|Sec|vs)\.)\s+/).map((s) => s.trim()).filter(Boolean);
const venuesIn = (s: string) => VENUES.filter(([re]) => re.test(s)).map(([, v]) => v);
const yearsIn = (s: string) => [...s.matchAll(/(?<!\d)(19[89]\d|20[0-4]\d)(?!\d)/g)].map((m) => Number(m[1]));

/** Problems of what a text claims about its paper's venue / year, given the library record. */
export function bibClaimProblems(text: string, f: BibFacts): string[] {
  const out: string[] = [];
  const where = [f.venue, f.year].filter(Boolean).join(" ");
  const aboutPaper = (s: string) => SELF_RE.test(s) || (!!f.title && s.toLowerCase().includes(f.title.toLowerCase().slice(0, 30))) || (!!f.first_author && new RegExp(`\\b${f.first_author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s));
  for (const s of sentences(text)) {
    const neg = NEG_RE.exec(s);
    if (neg) {
      out.push(f.preprint
        ? `「${s.slice(0, 60)}」：文獻庫只有預印本紀錄，不能推定它沒有正式發表；只能寫「目前只查到 arXiv 預印本紀錄」（或先用 refresh_paper_metadata 查證）`
        : `「${s.slice(0, 60)}」：文獻庫記錄這篇正式發表於 ${where}`);
      continue;
    }
    if (!PUBLISHED_RE.test(s) || !aboutPaper(s)) continue;
    const named = venuesIn(s).filter((v) => v !== "arXiv");
    if (!named.length) continue;
    if (f.preprint) out.push(`「${s.slice(0, 60)}」：文獻庫只有預印本紀錄，寫出的出處（${named.join("、")}）沒有查證過；先用 refresh_paper_metadata 查證`);
    else if (f.venue && !named.some((v) => v.toLowerCase() === f.venue!.toLowerCase())) out.push(`「${s.slice(0, 60)}」：寫的出處是 ${named.join("、")}，文獻庫記錄的是 ${where}`);
    else if (f.year && yearsIn(s).length && !yearsIn(s).includes(f.year)) out.push(`「${s.slice(0, 60)}」：年份和文獻庫記錄（${f.year}）不同`);
  }
  return [...new Set(out)].slice(0, 6);
}

/** Problems a text ADDS (an edit's own claims). */
export function newBibClaimProblems(before: string, after: string, f: BibFacts): string[] {
  const had = new Set(bibClaimProblems(before, f));
  return bibClaimProblems(after, f).filter((p) => !had.has(p));
}

Object.assign(CHECKS, {
  /** The artifact's claims about its paper's venue match the library record (params = BibFacts), notes included. */
  bib_claims(text: string, { params, data }: { params: Record<string, unknown>; data: unknown }) {
    const full = (data as { full?: unknown } | null)?.full;
    const problems = bibClaimProblems(typeof full === "string" && full.trim() ? full : text, params as unknown as BibFacts);
    return problems.length ? { ok: false, detail: `論文出處的說法和文獻庫紀錄不符：${problems.join("；")}。` } : { ok: true, detail: "論文出處的說法和文獻庫紀錄一致" };
  },
});
