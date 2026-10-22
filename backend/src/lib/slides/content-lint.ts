/**
 * Content checks of generated decks / notes against their sources (pure; unit-tested): the faults a professor flags
 * that layout checks cannot see.
 *  - names: model / dataset / method names that appear in neither the research brief nor the paper (`ungroundedNames`);
 *  - figures: a `paper-fig` crop whose caption names a different figure than the one at that place, notes naming
 *    another figure than the slide shows (`figureIssues`; `fixFigureRefs` rewrites refs to the measured figure list);
 *  - diagrams: `trainable` / `frozen` on inference-only steps (search, DTW, filtering, decoding …) or on parts the brief
 *    never says are trained; parallel items (applications, datasets, compared systems) drawn as an arrow chain
 *    (`diagramIssues`; `fixDiagrams` strips the markers and redraws such chains as a `grid`);
 *  - charts: one axis = one unit (no CCA values next to layer indices), an axis label / unit on every chart, and the
 *    same numbers charted on only one slide (`chartIssues`).
 * Slides are passed in (`{ title, body, notes, index }`, see workflows/checks.ts `parseSlides`); a note is one slide.
 */
import { figureRefOf } from "../library/figure-locate.js";
import { chartBlocks, figureRefs, parseDeckChart, replaceRanges, type DeckChart } from "./deck-visuals.js";
import { diagramBlocks, parseDiagram, type DiagramSpec } from "./diagram/index.js";

export type LintSlide = { title: string; body: string; notes: string; index: number };
/** A figure / table measured from the PDF layout (figure-locate `listFigures`): label "Fig. 2" / "Table 1". */
export type RefFigure = { label: string; page: number; top: number; bottom: number; left?: number; right?: number; caption?: string };
/**
 * What the content checks compare against (built once per run, passed to checks as the step output's `data.refs`):
 * `terms` = normalised name-like tokens of the brief + paper + request, `figures` = the measured figure list,
 * `training` = sentences of the sources about training, `outline` = the deck outline (title + points).
 */
export type ContentRefs = { terms?: string[]; figures?: RefFigure[]; training?: string; outline?: { title: string; points: string[] }[] };
export type SlideIssue = { index: number; title: string; issue: string };

const where = (s: LintSlide) => (s.index ? `第 ${s.index} 頁「${s.title}」` : "");

// ---------------------------------------------------------------- names (grounding)

/** Tokens that look like names: letters with optional digits, joined by - . + (wav2vec, HuBERT-Large, GPT-4, RNN-T). */
const TOKEN_RE = /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:[-.+][A-Za-z0-9]+)*/g;
export const termKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Single-capital names of well-known speech / NLP models and toolkits (a sentence-initial word is never a candidate otherwise). */
const KNOWN_NAMES = new Set(["whisper", "conformer", "zipformer", "squeezeformer", "branchformer", "emformer", "tacotron", "fastspeech", "wavenet", "jasper", "quartznet", "citrinet", "canary", "parakeet", "llama", "mistral", "qwen", "gemma", "gemini", "claude", "kaldi", "fairseq", "nemo", "icefall", "librispeech", "librilight", "switchboard", "fisher", "voxceleb", "voxpopuli", "gigaspeech", "aishell", "wenetspeech", "tedlium", "speechless", "seamless", "encodec", "soundstream", "vall", "bark", "speecht5", "unispeech", "titanet", "ecapa", "pyannote", "wenet", "espnet", "superb", "timit", "commonvoice", "mls", "fleurs"]);

/**
 * Acronyms and words that are generic terms, not claims about a specific model or dataset (metrics, model families,
 * units, file formats, venues, the Lab-Hub template): never flagged.
 */
const GENERIC = new Set(("wer cer per ser eer der mer wil asr tts stt slu nlu nlp sid kws vad llm llms lm lms am mlp mlps cnn cnns rnn rnns rnnt lstm blstm bilstm gru dnn tdnn hmm gmm mfcc mfccs fbank ctc att ffn mhsa relu gelu softmax mse mae nll kl elbo sgd pca svd lda snr db khz hz rtf rtfx flops gflops tflops auc roc oov ood iid ipa bpe gpu gpus cpu tpu api apis pdf url json svg html css png jpg qmd yaml latex markdown quarto sota tldr labhub hub fig figs eq eqs ref refs vs etc ie eg ms sec avg std max min tbd na faq qa ok todo ai ml dl ssl ssr sr ce ci tf idf tfidf id ids mos bleu rouge cider meteor f1 map mrr ndcg acc top1 top5 arxiv github icassp interspeech neurips nips icml iclr acl emnlp naacl taslp slt asru eusipco aaai ijcai cvpr iccv eccv ieee acm usa uk eu ntu nthu ncku ntust nycu tw lr tb td bt rl sft dpo ppo kd ema bn ln gn ar nar seq2seq e2e cv mt st sts ser").split(" "));

const components = (tok: string) => tok.split(/[-.+]/).filter(Boolean);
/** A component that, on its own, reads as a name (≥ 2 capitals, letters + digit, camel case, or a known name). */
function strong(c: string): boolean {
  const k = termKey(c);
  if (k.length < 3 || GENERIC.has(k) || GENERIC.has(k.replace(/s$/, ""))) return false;
  const uppers = (c.match(/[A-Z]/g) ?? []).length;
  const letters = (c.match(/[A-Za-z]/g) ?? []).length;
  return uppers >= 2 || (/\d/.test(c) && letters >= 3) || /^[a-z]+[A-Z]/.test(c) || KNOWN_NAMES.has(k);
}

/** Name-like keys of source texts (every token with a capital or digit, its components, known names in lower case). */
export function sourceTerms(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(TOKEN_RE)) {
      const tok = m[0];
      const k = termKey(tok);
      if (!(/[A-Z0-9]/.test(tok) || KNOWN_NAMES.has(k))) continue;
      out.add(k);
      for (const c of components(tok)) if (/[A-Z0-9]/.test(c) || KNOWN_NAMES.has(termKey(c))) out.add(termKey(c));
    }
  }
  return [...out].filter((k) => k.length >= 2).sort();
}

/** Text a reader sees or hears, without math, URLs, paper-fig refs, file paths and attribute blocks. */
const readable = (t: string) =>
  t
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\]\((?:paper-fig:|charts\/|diagrams\/|figures\/)[^)]*\)/g, "]")
    .replace(/\{[.#][^}]*\}|\{[a-z-]+="[^"]*"[^}]*\}/g, " ")
    .replace(/"(?:type|kind|icon|style|direction|flow|best|shape|side)"\s*:\s*"[^"]*"/g, " ");

/**
 * Names in `text` (models, datasets, methods) that none of the source `terms` contain. A token is known when its key,
 * its singular, or every name-like component of it is a source term (HuBERT-Large ok when the paper names HuBERT).
 */
export function ungroundedNames(text: string, terms: Iterable<string>): string[] {
  const known = terms instanceof Set ? (terms as Set<string>) : new Set(terms);
  const out = new Map<string, string>();
  for (const m of readable(text).matchAll(TOKEN_RE)) {
    const tok = m[0].replace(/[.]+$/, "");
    const comps = components(tok).filter(strong);
    if (!comps.length) continue;
    const k = termKey(tok);
    if (GENERIC.has(k)) continue;
    const ok = known.has(k) || known.has(k.replace(/s$/, "")) || comps.every((c) => known.has(termKey(c)) || known.has(termKey(c).replace(/s$/, "")));
    if (!ok && !out.has(k)) out.set(k, tok);
  }
  return [...out.values()];
}

/** Per-slide names not found in the sources. */
export function nameIssues(slides: LintSlide[], terms: Iterable<string>): SlideIssue[] {
  const known = new Set(terms);
  const out: SlideIssue[] = [];
  for (const s of slides) {
    const names = ungroundedNames(`${s.title}\n${s.body}\n${s.notes}`, known);
    if (names.length) out.push({ index: s.index, title: s.title, issue: `提到來源（論文全文、研究摘要）裡沒有的名稱：${names.slice(0, 6).map((n) => `「${n}」`).join("、")}。請刪掉，或改成來源裡實際出現的模型／資料集／方法` });
  }
  return out;
}

// ---------------------------------------------------------------- figures

const sameFig = (a: { kind: string; num: number } | null, b: { kind: string; num: number } | null) => !!a && !!b && a.kind === b.kind && a.num === b.num;
const listedOf = (figures: RefFigure[], ref: { kind: string; num: number } | null) => (ref ? figures.find((f) => sameFig(figureRefOf(f.label), ref)) : undefined);
const f2 = (x: number) => x.toFixed(2);

/** Exact writer syntax for a listed figure (the figure list the writer copies from). */
export const figureSyntax = (f: RefFigure, caption = "一句說明") => `![${f.label}: ${caption} (p. ${f.page})](paper-fig:${f.page}@${f2(f.top)}-${f2(f.bottom)})`;

/**
 * Rewrites `paper-fig` refs to the measured figure list: a caption naming Fig. N gets the page and band of Fig. N
 * (and its "(p. X)"); a caption without a number whose band overlaps exactly one listed figure on that page gets its
 * label. Returns the body and the number of refs changed.
 */
export function fixFigureRefs(body: string, figures: RefFigure[]): { body: string; fixed: number } {
  if (!figures.length) return { body, fixed: 0 };
  let fixed = 0;
  const refs = figureRefs(body);
  const out = replaceRanges(body, refs, (f) => {
    const orig = body.slice(f.start, f.end);
    const ref = figureRefOf(f.caption);
    let listed = listedOf(figures, ref);
    let caption = f.caption;
    if (!ref) {
      const overlap = (g: RefFigure) => Math.min(g.bottom, f.bottom) - Math.max(g.top, f.top);
      const near = figures.filter((g) => g.page === f.page && overlap(g) > 0.5 * Math.min(g.bottom - g.top, f.bottom - f.top));
      if (near.length !== 1) return orig;
      listed = near[0]!;
      caption = `${listed.label}: ${caption}`;
    }
    if (!listed) return orig;
    caption = caption.replace(/\(\s*p\.\s*\d+\s*\)|（\s*p\.\s*\d+\s*）/i, `(p. ${listed.page})`);
    if (caption === f.caption && listed.page === f.page && Math.abs(listed.top - f.top) < 0.03 && Math.abs(listed.bottom - f.bottom) < 0.03) return orig;
    fixed++;
    return `![${caption}](paper-fig:${listed.page}@${f2(listed.top)}-${f2(listed.bottom)})${f.attrs}`;
  });
  return { body: out, fixed };
}

const MENTION_RE = /(?<![A-Za-z])(fig(?:ure)?s?\.?|table|tab\.|圖|表)\s*(\d{1,2})(?!\d)/gi;
const MENTION_PAGE_RE = /(?<![A-Za-z])(fig(?:ure)?\.?|table|tab\.|圖|表)\s*(\d{1,2})\s*[,，、;；:：(（\s]\s*(?:p\.\s*|pp\.\s*|第\s*)(\d{1,3})/gi;

/**
 * Figure-reference faults per slide: a crop captioned without Fig. N／Table N, a crop whose page is not where the
 * figure list puts Fig. N, text / notes naming another figure of the same kind than the one the slide shows, and a
 * mention "Fig. N (p. X)" with the wrong page.
 */
export function figureIssues(slides: LintSlide[], figures: RefFigure[]): SlideIssue[] {
  const out: SlideIssue[] = [];
  const add = (s: LintSlide, issue: string) => out.push({ index: s.index, title: s.title, issue });
  for (const s of slides) {
    const refs = figureRefs(s.body);
    const shown = refs.map((f) => figureRefOf(f.caption)).filter((x): x is NonNullable<typeof x> => !!x);
    for (const f of refs) {
      const ref = figureRefOf(f.caption);
      if (!ref) {
        add(s, `論文圖（paper-fig:${f.page}）的圖說沒有寫 Fig. N／Table N：照圖表清單整行複製，圖說保留它的編號`);
        continue;
      }
      const listed = listedOf(figures, ref);
      if (listed && listed.page !== f.page) add(s, `圖說寫 ${listed.label}，但 paper-fig 指到第 ${f.page} 頁（${listed.label} 在第 ${listed.page} 頁）：改用圖表清單那一行的 ${figureSyntax(listed).replace(/^!\[[^\]]*\]/, "")}`);
    }
    const text = `${s.body.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")}\n${s.notes}`;
    if (shown.length) {
      const mentioned = [...text.matchAll(MENTION_RE)].map((m) => figureRefOf(`${m[1]} ${m[2]}`)).filter((x): x is NonNullable<typeof x> => !!x);
      const other = mentioned.filter((m) => shown.some((x) => x.kind === m.kind) && !shown.some((x) => sameFig(x, m)));
      const own = mentioned.some((m) => shown.some((x) => sameFig(x, m)));
      if (other.length && !own) {
        const name = (r: { kind: string; num: number }) => `${r.kind === "figure" ? "Fig." : "Table"} ${r.num}`;
        add(s, `內容或講稿提到 ${[...new Set(other.map(name))].join("、")}，但這頁放的是 ${[...new Set(shown.map(name))].join("、")}：圖號要和放的圖一致（改正文字裡的編號，或換成那張圖的 paper-fig）`);
      }
    }
    if (figures.length) {
      for (const m of text.matchAll(MENTION_PAGE_RE)) {
        const listed = listedOf(figures, figureRefOf(`${m[1]} ${m[2]}`));
        if (listed && Number(m[3]) !== listed.page) add(s, `「${m[0].trim()}」的頁碼不對：${listed.label} 在第 ${listed.page} 頁`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- diagrams

/** Steps without parameters: never `trainable`, never `frozen` (labels in English or 中文). */
export const INFERENCE_ONLY_RE = /\b(?:search|beam|dtw|dynamic time warping|decoding|viterbi|greedy|filtering|filter out|threshold(?:ing)?|argmax|top-?k|look-?up|retrieval|nearest[- ]neighbou?r|knn|k-nn|cosine similarity|similarity|scoring|ranking|prun(?:e|ing)|selection|post-?process\w*|evaluat\w*|wer|cer|cca|svcca|pwcca|cka|pca|svd|k-?means|clustering|forced alignment|mfa)\b|搜尋|檢索|解碼|過濾|篩選|門檻|閾值|比對|評估|評分|相似度|排序|分群/i;
const TRAIN_RE = /\btrain(?:s|ed|ing|able)?\b|fine-?tun\w*|\blearn(?:s|ed|ing|able)?\b|optimi[sz]\w*|update[sd]?|from scratch|\bloss\b|訓練|微調|學習|最佳化|更新/i;
const STOP = new Set(["the", "and", "for", "with", "layer", "layers", "module", "block", "blocks", "model", "models", "network", "head", "heads", "step", "stage", "new", "our", "ours", "proposed"]);

/** Sentences of the sources about training (for `trained` lookups); bounded. */
export function trainingSentences(texts: string[], max = 12_000): string {
  const out: string[] = [];
  let n = 0;
  for (const t of texts) {
    for (const sent of t.split(/(?<=[.!?。！？])\s+|\n+/)) {
      if (!TRAIN_RE.test(sent)) continue;
      const s = sent.trim().slice(0, 400);
      if (!s || n + s.length > max) continue;
      out.push(s);
      n += s.length + 1;
    }
  }
  return out.join("\n");
}

const words = (t: string) => t.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((w) => w.length >= 2);
/** Whether a training sentence names the component (a significant word of its label); labels of only generic words pass. */
function trainedInSources(label: string, training: string): boolean {
  const sig = words(label.replace(/\$[^$]*\$/g, " ")).filter((w) => w.length >= 3 && !STOP.has(w));
  if (!sig.length) return true;
  const low = training.toLowerCase();
  return sig.some((w) => low.includes(w));
}

const PEER_RE = /\b(?:applications?|use cases?|datasets?|corpora|benchmarks?|downstream|tasks?|baselines?|compared (?:systems|models|methods)|(?:systems|models|methods) compared|variants|families|categories|toolkits?|tools)\b|應用|資料集|語料|基準|下游任務|任務|比較對象|比較的(?:系統|模型|方法)|基線|種類|類別|工具/i;
/** Labels that are actions (a step of a procedure, not a peer item). */
const ACTION_RE = /\b(?:train|fine-?tun|pre-?train|evaluat|extract|encod|decod|predict|comput|align|project|pool|classif|transcrib|generat|segment|filter|search|scor|fus|merg|concat|inject|feed|normali[sz]|tokeni[sz]|quantiz|cluster)\w*|訓練|微調|計算|擷取|抽取|預測|編碼|解碼|對齊|產生|轉錄|分類|過濾|搜尋/i;
const SEQ_RE = /→|->|⇒|=>|\bthen\b|\bfollowed by\b|\bfeeds?\b|接著|然後|再由|之後|輸入到|送進/i;

/** A label occurs in a line: every word of it starts a word of the line (Speaker ID ↔ speaker identification); CJK by substring. */
function labelIn(label: string, line: string): boolean {
  const plain = label.replace(/\$[^$]*\$/g, " ");
  if (/[一-鿿]/.test(plain)) return line.includes(plain.trim());
  const lw = words(plain);
  const tw = words(line);
  return lw.length > 0 && lw.every((w) => tw.some((x) => x.startsWith(w)));
}

/** Node ids of a plain arrow chain (pipeline of single stages, or a graph that is one path), else null. */
function chainOf(spec: DiagramSpec): string[] | null {
  const plainEdges = spec.edges.every((e) => !e.label && e.kind === "flow");
  if (spec.type === "pipeline") {
    if (spec.direction !== "LR" && spec.direction !== "TB") return null;
    if (spec.stages.some((s) => s.length !== 1) || (spec.explicitEdges && !plainEdges)) return null;
    return spec.stages.map((s) => s[0]!);
  }
  if (spec.type === "graph" && plainEdges && spec.edges.length === spec.nodes.size - 1) {
    const indeg = new Map<string, number>();
    const next = new Map<string, string>();
    for (const e of spec.edges) {
      if (next.has(e.from)) return null;
      next.set(e.from, e.to);
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
    const start = [...spec.nodes.keys()].filter((id) => !indeg.has(id));
    if (start.length !== 1 || [...indeg.values()].some((v) => v > 1)) return null;
    const out = [start[0]!];
    while (next.has(out.at(-1)!) && out.length <= spec.nodes.size) out.push(next.get(out.at(-1)!)!);
    return out.length === spec.nodes.size ? out : null;
  }
  return null;
}

/**
 * Parallel items drawn as an arrow chain: ≥ 3 unlabeled steps of the same kind (no input / output / data node), and
 * either the slide is about peers (applications, datasets, compared systems, tasks) or ≥ 3 of the labels are listed
 * together in one line of the outline / bullets / notes without any sequence word. Comparison panels of one box each
 * are peers drawn as lanes. Returns the peers' labels, or null.
 */
export function peerChain(spec: DiagramSpec, context: { title: string; lines: string[] }): string[] | null {
  if (spec.type === "comparison" && spec.panels.length >= 3 && spec.panels.every((p) => p.stages.flat().length <= 1)) return spec.panels.map((p) => p.title);
  const ids = chainOf(spec);
  if (!ids || ids.length < 3) return null;
  const nodes = ids.map((id) => spec.nodes.get(id)!);
  if (nodes.some((n) => n.kind === "input" || n.kind === "output" || n.kind === "data" || n.kind === "note")) return null;
  if (new Set(nodes.map((n) => (n.kind === "highlight" ? "model" : n.kind))).size > 1) return null;
  const labels = nodes.map((n) => n.label);
  const listed = context.lines.some((l) => !SEQ_RE.test(l) && labels.filter((lab) => labelIn(lab, l)).length >= Math.max(3, Math.ceil(labels.length * 0.6)));
  // The title alone (「Datasets & training」) is weaker evidence: a chain with an action step is a procedure.
  return listed || (PEER_RE.test(context.title) && !labels.some((l) => ACTION_RE.test(l))) ? labels : null;
}

/** Peer chains / lanes redrawn as a `grid` (same nodes, no arrows); null when the spec is not one. */
export function gridFromPeers(spec: DiagramSpec): Record<string, unknown> {
  const nodes =
    spec.type === "comparison"
      ? spec.panels.map((p) => {
          const inner = p.stages.flat()[0];
          const n = inner ? spec.nodes.get(inner) : undefined;
          return { label: p.title, ...(n ? { sub: n.label } : p.sub ? { sub: p.sub } : {}), kind: p.highlight ? "highlight" : "model" };
        })
      : (chainOf(spec) ?? [...spec.nodes.keys()]).map((id) => {
          const { id: nid, label, sub, kind, icon, badge, frozen, trainable } = spec.nodes.get(id)!;
          return { id: nid, label, ...(sub ? { sub } : {}), kind, ...(icon ? { icon } : {}), ...(badge ? { badge } : {}), ...(frozen ? { frozen } : {}), ...(trainable ? { trainable } : {}) };
        });
  return { type: "grid", nodes, ...(spec.caption ? { caption: spec.caption } : {}), ...(spec.legend === false ? { legend: false } : {}) };
}

/** Outline points of the page with this title + the slide's own lines (bullets, notes). */
function contextLines(s: LintSlide, refs: ContentRefs): string[] {
  const norm = (t: string) => t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const page = refs.outline?.find((o) => norm(o.title) === norm(s.title) || norm(o.title).includes(norm(s.title)) || norm(s.title).includes(norm(o.title)));
  const own = `${s.body.replace(/^```[\s\S]*?^```/gm, " ")}\n${s.notes}`.split(/\n|(?<=[.。；;])\s*/);
  return [...(page?.points ?? []), ...own].map((l) => l.trim()).filter(Boolean);
}

type Marked = { label: string; trainable: boolean; frozen: boolean; kind: string };
/** Nodes of a raw spec object carrying a trainable / frozen marker. */
function markedNodes(raw: unknown, out: Marked[] = []): Marked[] {
  if (Array.isArray(raw)) raw.forEach((x) => markedNodes(x, out));
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const label = String(o.label ?? o.name ?? o.text ?? o.id ?? "");
    if (label && (o.trainable === true || o.trained === true || o.frozen === true)) out.push({ label, trainable: o.trainable === true || o.trained === true, frozen: o.frozen === true, kind: String(o.kind ?? "") });
    for (const v of Object.values(o)) if (v && typeof v === "object") markedNodes(v, out);
  }
  return out;
}

const markerProblem = (n: Marked, training: string | undefined): string | null => {
  const what = n.trainable ? "trainable" : "frozen";
  if (INFERENCE_ONLY_RE.test(n.label) || /^(input|data|output|dataset|in|out)$/i.test(n.kind)) return `「${n.label}」是推論步驟或資料（沒有參數），不能標 ${what}`;
  if (n.trainable && training !== undefined && !trainedInSources(n.label, training)) return `「${n.label}」標成 trainable，但論文與研究摘要沒有說這個元件在本文被訓練：拿掉 trainable（只標論文明說要訓練的元件）`;
  return null;
};

/** Diagram semantics per slide: unfounded trainable / frozen markers, parallel items drawn as a flow. */
export function diagramIssues(slides: LintSlide[], refs: ContentRefs = {}): SlideIssue[] {
  const out: SlideIssue[] = [];
  for (const s of slides) {
    for (const d of diagramBlocks(s.body)) {
      let raw: unknown;
      try {
        raw = JSON.parse(d.source);
      } catch {
        continue;
      }
      for (const n of markedNodes(raw)) {
        const p = markerProblem(n, refs.training);
        if (p) out.push({ index: s.index, title: s.title, issue: p });
      }
      const spec = parseDiagram(d.source).spec;
      const peers = spec ? peerChain(spec, { title: s.title, lines: contextLines(s, refs) }) : null;
      if (peers) out.push({ index: s.index, title: s.title, issue: `圖把並列的項目畫成流程（${peers.slice(0, 4).join(" → ")}）：它們沒有先後關係，改用 {"type":"grid"}（或表格），不要用箭頭串起來` });
    }
  }
  return out;
}

/** Strips unfounded trainable / frozen flags of a raw spec (in place); returns how many nodes changed. */
function stripMarkers(raw: unknown, training: string | undefined): number {
  let n = 0;
  if (Array.isArray(raw)) for (const x of raw) n += stripMarkers(x, training);
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const label = String(o.label ?? o.name ?? o.text ?? o.id ?? "");
    const m: Marked = { label, trainable: o.trainable === true || o.trained === true, frozen: o.frozen === true, kind: String(o.kind ?? "") };
    if (label && (m.trainable || m.frozen) && markerProblem(m, training)) {
      for (const k of ["trainable", "trained", "frozen"]) delete o[k];
      n++;
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") n += stripMarkers(v, training);
  }
  return n;
}

/**
 * Structural fixes of ```diagram blocks (deterministic, before any check): unfounded trainable / frozen markers are
 * removed, peer chains / lanes become a `grid`. Returns the body and the number of diagrams changed.
 */
export function fixDiagrams(body: string, refs: ContentRefs = {}, slides?: LintSlide[]): { body: string; fixed: number } {
  let fixed = 0;
  const out = body
    .split(/^(?=## )/m)
    .map((part, i) => {
      const blocks = diagramBlocks(part);
      if (!blocks.length) return part;
      const nl = part.indexOf("\n");
      const title = (nl < 0 ? part.slice(3) : part.slice(3, nl)).replace(/\{[^}]*\}\s*$/, "").trim();
      const slide: LintSlide = slides?.find((s) => s.title === title) ?? { title, body: part.replace(/^:::+\s*\{?\.?notes\}?\s*\n[\s\S]*?^:::+\s*$/gm, ""), notes: [...part.matchAll(/^:::+\s*\{?\.?notes\}?\s*\n([\s\S]*?)^:::+\s*$/gm)].map((m) => m[1]).join("\n"), index: i };
      return replaceRanges(part, blocks, (d) => {
        const orig = part.slice(d.start, d.end);
        let raw: unknown;
        try {
          raw = JSON.parse(d.source);
        } catch {
          return orig;
        }
        let changed = stripMarkers(raw, refs.training) > 0;
        let next: unknown = raw;
        const spec = parseDiagram(JSON.stringify(raw)).spec;
        if (spec && peerChain(spec, { title, lines: contextLines(slide, refs) })) {
          next = gridFromPeers(spec);
          changed = true;
        }
        if (!changed) return orig;
        fixed++;
        return `\`\`\`diagram\n${JSON.stringify(next)}\n\`\`\``;
      });
    })
    .join("");
  return { body: out, fixed };
}

// ---------------------------------------------------------------- charts

/** Quantity families recognised in chart labels / series names. */
const QUANTITIES: [string, RegExp][] = [
  ["layer", /\blayers?\b|\blayer index\b|\bdepth\b|\bL\d+\b|層/i],
  ["correlation", /\b(?:sv|pw)?cca\b|\bcka\b|correlation|similarity|相關|相似度/i],
  ["error rate", /\b[wcp]er\b|\beer\b|error rate|錯誤率/i],
  ["accuracy", /accuracy|\bacc\b|\bf1\b|precision|recall|\bauc\b|準確/i],
  ["time", /\btime\b|latency|\brtf\b|\bms\b|seconds?|秒|延遲/i],
  ["size", /\bparams?\b|parameters|model size|\bhours?\b|小時|參數/i],
  ["count", /\bcount\b|number of|\bnum\b|數量|次數/i],
];
const quantityOf = (t: string | undefined) => (t ? QUANTITIES.filter(([, re]) => re.test(t)).map(([k]) => k) : []);
const valuesOf = (c: DeckChart) => (c.type === "heatmap" ? (c.values ?? []).flat() : c.series.flatMap((s) => s.data.flatMap((d) => (Array.isArray(d) ? [d[1]] : [d])))).filter((v): v is number => typeof v === "number" && Number.isFinite(v));

/** Why a chart mixes incomparable quantities on one axis, or null. */
export function mixedUnits(c: DeckChart): string | null {
  if (c.type === "heatmap" || c.type === "scatter") return null;
  // Several series: each series is one quantity; two families on one axis (or ranges 30× apart) are not comparable.
  if (c.series.length > 1) {
    const kinds = new Set(c.series.flatMap((s) => quantityOf(s.name)));
    if (kinds.size > 1) return `系列混了不同的量（${[...kinds].join("、")}）`;
    const peaks = c.series.map((s) => Math.max(...s.data.map((d) => (typeof d === "number" ? Math.abs(d) : 0)))).filter((v) => v > 0);
    if (peaks.length > 1 && Math.max(...peaks) / Math.min(...peaks) >= 30) return `系列的數值範圍差太多（最大 ${Math.max(...peaks)} vs ${Math.min(...peaks)}），應該是不同單位`;
    return null;
  }
  // One series: categories that are different quantities (CCA value, best layer), a correlation above 1, or 0–1 values
  // next to values ≥ 10× larger when only some categories name a quantity.
  const kinds = new Set((c.labels ?? []).flatMap(quantityOf));
  if (kinds.size > 1) return `同一個軸上的類別是不同的量（${[...kinds].join("、")}）`;
  const vals = valuesOf(c);
  const axis = quantityOf([c.series[0]?.name, c.y_label, c.x_label, c.unit, c.title].filter(Boolean).join(" "));
  if ((axis.includes("correlation") || kinds.has("correlation")) && !kinds.has("layer") && vals.some((v) => Math.abs(v) > 1) && vals.some((v) => Math.abs(v) < 1)) return `相關／相似度只在 0–1 之間，但同一個軸上有 ${vals.find((v) => Math.abs(v) > 1)}（應該是別的量，例如層數）`;
  const frac = vals.filter((v) => Math.abs(v) > 0 && Math.abs(v) < 1 && !Number.isInteger(v));
  const big = vals.filter((v) => Math.abs(v) >= 2);
  if (kinds.size === 1 && frac.length && big.length && Math.max(...big.map(Math.abs)) / Math.max(...frac.map(Math.abs)) >= 10) return `同一個軸上同時有 0–1 的值（${frac[0]}）與大很多的值（${big[0]}），應該是不同單位`;
  return null;
}

/** Axis label / unit present for the chart's value axis. */
function hasAxis(c: DeckChart): boolean {
  if (c.unit) return true;
  if (c.type === "hbar") return !!c.x_label;
  if (c.type === "scatter") return !!c.x_label && !!c.y_label;
  return !!c.y_label;
}

/** Chart faults per slide: no axis label / unit, mixed units on one axis, the same numbers charted on another slide. */
export function chartIssues(slides: LintSlide[]): SlideIssue[] {
  const out: SlideIssue[] = [];
  const seen: { slide: LintSlide; nums: number[] }[] = [];
  for (const s of slides) {
    for (const b of chartBlocks(s.body)) {
      const c = b.spec ?? parseDeckChart(b.source);
      if (!c) continue;
      const name = c.title ? `「${c.title}」` : "";
      if (!hasAxis(c)) out.push({ index: s.index, title: s.title, issue: `圖表${name}沒有座標軸標籤或單位：加上 ${c.type === "hbar" ? "x_label" : "y_label"}（例如 "WER (%)"）或 "unit"` });
      const mixed = mixedUnits(c);
      if (mixed) out.push({ index: s.index, title: s.title, issue: `圖表${name}把不能比較的量畫在同一個軸上：${mixed}。一個軸只能有一種單位：分成兩張圖表，或改用表格` });
      const nums = valuesOf(c);
      for (const prev of seen) {
        if (prev.slide === s) continue;
        const pool = [...prev.nums];
        let shared = 0;
        for (const v of nums) {
          const i = pool.indexOf(v);
          if (i >= 0) {
            shared++;
            pool.splice(i, 1);
          }
        }
        // ≥ 3 shared values making up most of the smaller chart, or every value of a small chart (non-trivial numbers).
        const small = Math.min(nums.length, prev.nums.length);
        const telling = nums.some((v) => !Number.isInteger(v) || Math.abs(v) >= 10);
        if ((shared >= 3 && shared >= 0.6 * small) || (shared >= 2 && shared === small && telling)) {
          out.push({ index: s.index, title: s.title, issue: `和${where(prev.slide) || "另一頁"}的圖表是同一組數字：同一組資料整份簡報只畫一次，這頁改放別的內容（或用不同的資料）` });
          break;
        }
      }
      seen.push({ slide: s, nums });
    }
  }
  return out;
}

/** Every content issue of a deck / note (grouped per slide for the fixer). */
export function contentIssues(slides: LintSlide[], refs: ContentRefs = {}): SlideIssue[] {
  return [...(refs.terms ? nameIssues(slides, refs.terms) : []), ...figureIssues(slides, refs.figures ?? []), ...diagramIssues(slides, refs), ...chartIssues(slides)];
}

export const formatIssues = (issues: SlideIssue[]) => issues.map((i) => `${i.index ? `第 ${i.index} 頁「${i.title}」` : ""}${i.index ? "：" : ""}${i.issue}`);
