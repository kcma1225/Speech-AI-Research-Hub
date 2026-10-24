/**
 * Eval fixtures on the target hub (idempotent): two studies owned by the eval user —
 *   main   「Agent 評估集：串流 ASR 熱詞偏置」: 10 contextual-biasing / ASR papers with PDFs, one paper without a PDF
 *          (a manual record, so open-access lookup cannot find one), progress data (milestones, tasks), a weekly
 *          meeting note and a research note;
 *   single 「Agent 評估集：單篇論文研究」: exactly one paper (wav2vec 2.0, with PDF) + progress data — a progress deck
 *          must stay a progress deck there.
 * Papers are taken from the lab library when present (matched by arXiv id / DOI), else added by identifier.
 * Decks that a task edits are created fresh per task (`createDeck`) so tasks never share state.
 */
import { HttpFail, type Hub } from "./client.js";
import type { PaperRef } from "./graders.js";

export const MAIN_TITLE = "Agent 評估集：串流 ASR 熱詞偏置";
export const SINGLE_TITLE = "Agent 評估集：單篇論文研究";
const MARK = "（Agent 評估集固定資料，請勿修改；由 backend/scripts/eval/fixtures.ts 建立）";

type Ident = { arxiv?: string; doi?: string; short: string };
const MAIN_PAPERS: Ident[] = [
  { arxiv: "1808.02480", short: "Deep context (CLAS)" },
  { doi: "10.21437/interspeech.2019-1209", short: "Shallow-fusion contextual biasing" },
  { arxiv: "2205.13660", short: "Contextual adapters" },
  { arxiv: "2306.00804", short: "Adaptive contextual biasing (transducer, streaming)" },
  { arxiv: "2310.00178", short: "KMP contextual biasing" },
  { arxiv: "2405.13344", short: "Dynamic vocabulary" },
  { arxiv: "2407.10303", short: "Early context injection" },
  { arxiv: "2401.08835", short: "Guided attention biasing" },
  { arxiv: "2506.01263", short: "WCTC-biasing" },
  { arxiv: "2005.08100", short: "Conformer" },
];
const SINGLE_PAPER: Ident = { arxiv: "2006.11477", short: "wav2vec 2.0" };

/** Manual record without identifiers: the missing-PDF case (autoFetchPdf has nothing to look up). */
export const NO_PDF_TITLE = "Hotword Biasing for Low-Resource Taiwanese Mandarin Streaming ASR (eval fixture without PDF)";

const WEEKLY_NOTE = `## 本週進度

- 在 icefall 上跑通 Zipformer 串流 RNN-T 基線（AISHELL-1 dev CER 5.1%）
- 讀完 CLAS（Deep context）與 shallow fusion 兩篇，整理成閱讀筆記
- 熱詞清單：從課程錄音整理出 320 個專有名詞

## 遇到的問題

- 熱詞清單一大（> 300 個）時 CLAS 的注意力分散，罕見詞召回率下降
- 串流模式下 lookahead 只有 320 ms，偏置分數容易誤觸發

## 老師回饋

- 先把評估指標定好：罕見詞 recall、整體 CER、誤觸發率
- 比較 shallow fusion 與 neural biasing 在同一份熱詞清單上的表現

## 下週

- 實作 trie-based shallow fusion 作為 baseline
- 準備 ICASSP 投稿的實驗表格
`;

const RESEARCH_NOTE = `## 研究問題

在 Zipformer + RNN-T 的串流辨識中，讓使用者提供的熱詞（人名、課程術語）更容易被辨識，而且不重新訓練整個模型。

## 目前看過的做法

- **Shallow fusion**：解碼時對熱詞字首樹加分，不需訓練；可能誤觸發 [@zhao2019shallow]
- **CLAS / Deep context**：用注意力把熱詞嵌入接到解碼器，需要訓練 [@pundak2018deep]
- **Contextual adapters**：凍結主模型，只訓練小的 adapter [@sathyendra2022contextual]
- **Adaptive biasing**：串流 transducer 上依情境開關偏置 [@xu2023adaptive]

## 待確認

- 這些方法在 Zipformer 的哪一層注入熱詞資訊
- 熱詞清單變大時的效率
`;

export type FixturePaper = PaperRef & { id: string; hasPdf: boolean };
export type Fixtures = {
  main: { id: string; slug: string; papers: FixturePaper[]; noPdfId: string; noteIds: string[]; /** every cite key of the study (incl. the paper without PDF) */ keys: string[] };
  single: { id: string; slug: string; paper: FixturePaper };
};

type StudyCard = { id: string; slug: string; title: string };

async function ensureStudy(hub: Hub, title: string, summary: string): Promise<StudyCard> {
  const { studies } = await hub.api<{ studies: StudyCard[] }>("GET", "/studies?scope=mine");
  const found = studies.find((s) => s.title === title);
  if (found) return found;
  return (await hub.api<{ study: StudyCard }>("POST", "/studies", { title, summary_md: `${summary}\n\n${MARK}` })).study;
}

type StudyPaper = { paper: { id: string; title: string; authors?: { family?: string; literal?: string }[]; year?: number | null; has_pdf: boolean; arxiv_id?: string | null; doi?: string | null }; cite_key: string };

/** Every cite key the study's library has now (a topic workflow imports papers into it during the run). */
export async function studyKeys(hub: Hub, studyId: string): Promise<string[]> {
  return (await studyPapers(hub, studyId)).map((sp) => sp.cite_key);
}

async function studyPapers(hub: Hub, studyId: string): Promise<StudyPaper[]> {
  return (await hub.api<{ papers: StudyPaper[] }>("GET", `/studies/${studyId}/papers?status=all`)).papers;
}

async function ensurePaper(hub: Hub, studyId: string, have: StudyPaper[], ident: Ident) {
  const id = (ident.arxiv ?? ident.doi)!;
  const match = (p: StudyPaper["paper"]) => (ident.arxiv && p.arxiv_id === ident.arxiv) || (ident.doi && p.doi?.toLowerCase() === ident.doi.toLowerCase());
  if (have.some((sp) => match(sp.paper))) return;
  const lib = await hub.api<{ papers: StudyPaper["paper"][] }>("GET", `/library/papers?q=${encodeURIComponent(id)}&limit=5`);
  const inLib = lib.papers.find(match);
  if (inLib) {
    await hub.api("POST", `/studies/${studyId}/papers`, { paperId: inLib.id }).catch((e) => {
      if (!(e instanceof HttpFail && e.status === 409)) throw e;
    });
    return;
  }
  await hub.api("POST", "/library/papers", { identifier: ident.arxiv ? `arXiv:${ident.arxiv}` : ident.doi, study: studyId, onDuplicate: "link" });
}

async function ensureNote(hub: Hub, studyId: string, title: string, content: string): Promise<string> {
  const { notes } = await hub.api<{ notes: { id: string; title: string }[] }>("GET", `/studies/${studyId}/notes`);
  const found = notes.find((n) => n.title === title);
  if (found) return found.id;
  return (await hub.api<{ note: { id: string } }>("POST", `/studies/${studyId}/notes`, { title, content_md: content })).note.id;
}

async function ensureProgress(hub: Hub, studyId: string, tasks: string[], milestones: { title: string; due_on: string }[]) {
  const detail = await hub.api<{ milestones?: { title: string }[] }>("GET", `/studies/${studyId}`);
  const listed = await hub.api<{ tasks: { title: string }[] }>("GET", `/studies/${studyId}/tasks?status=all`);
  const haveTasks = new Set(listed.tasks.map((t) => t.title));
  for (const t of tasks) if (!haveTasks.has(t)) await hub.api("POST", `/studies/${studyId}/tasks`, { title: t });
  const haveMs = new Set((detail.milestones ?? []).map((m) => m.title));
  for (const m of milestones) if (!haveMs.has(m.title)) await hub.api("POST", `/studies/${studyId}/milestones`, m);
}

const toRef = (sp: StudyPaper): FixturePaper => {
  const a = sp.paper.authors?.[0];
  return { id: sp.paper.id, key: sp.cite_key, title: sp.paper.title, author: a?.family ?? a?.literal, year: sp.paper.year ?? null, hasPdf: sp.paper.has_pdf };
};

export async function ensureFixtures(hub: Hub): Promise<Fixtures> {
  const main = await ensureStudy(hub, MAIN_TITLE, "在 Zipformer + RNN-T 串流語音辨識中做動態熱詞（contextual biasing），不重新訓練整個模型，讓人名與課程術語更容易被辨識。目標：ICASSP 2027 投稿。");
  let have = await studyPapers(hub, main.id);
  for (const p of MAIN_PAPERS) await ensurePaper(hub, main.id, have, p);
  if (!have.some((sp) => sp.paper.title === NO_PDF_TITLE)) {
    await hub.api("POST", "/library/papers", { record: { type: "paper-conference", title: NO_PDF_TITLE, author: [{ family: "Lin", given: "Ya-Ting" }], issued: { "date-parts": [[2025]] }, "container-title": "Eval fixture" }, study: main.id, onDuplicate: "add" });
  }
  have = await studyPapers(hub, main.id);
  const noPdf = have.find((sp) => sp.paper.title === NO_PDF_TITLE);
  if (!noPdf) throw new Error("fixture paper without PDF missing");
  if (noPdf.paper.has_pdf) throw new Error(`fixture paper ${noPdf.paper.id} unexpectedly has a PDF`);
  const noteIds = [await ensureNote(hub, main.id, "週會筆記 2026-10-20（熱詞偏置）", WEEKLY_NOTE), await ensureNote(hub, main.id, "調研：串流 RNN-T 的動態熱詞", RESEARCH_NOTE)];
  await ensureProgress(hub, main.id, ["實作 trie-based shallow fusion baseline", "整理罕見詞 recall 評估腳本", "準備 ICASSP 實驗表格"], [{ title: "ICASSP 2027 投稿", due_on: "2026-11-15" }, { title: "期中口試", due_on: "2027-01-10" }]);

  const single = await ensureStudy(hub, SINGLE_TITLE, "用 wav2vec 2.0 自監督特徵做台灣華語低資源語音辨識的微調實驗。");
  const sHave = await studyPapers(hub, single.id);
  await ensurePaper(hub, single.id, sHave, SINGLE_PAPER);
  await ensureNote(hub, single.id, "週會筆記 2026-10-21", "## 本週進度\n\n- 用 10 小時台灣華語資料微調 wav2vec 2.0 base，dev CER 18.2%\n- 嘗試凍結前 6 層，CER 19.0%\n\n## 問題\n\n- 資料太少，過擬合明顯\n\n## 下週\n\n- 加入 SpecAugment 與速度擾動\n");
  await ensureProgress(hub, single.id, ["加入 SpecAugment", "整理微調超參數表"], [{ title: "期中報告", due_on: "2026-12-01" }]);
  const sPapers = await studyPapers(hub, single.id);
  if (sPapers.length !== 1) throw new Error(`single-paper study has ${sPapers.length} papers`);

  const papers = have.filter((sp) => sp.paper.has_pdf).map(toRef);
  if (papers.length < 8) throw new Error(`main fixture study has only ${papers.length} papers with PDFs (PDF fetch may still be queued; re-run in a minute)`);
  return { main: { id: main.id, slug: main.slug, papers, noPdfId: noPdf.paper.id, noteIds, keys: have.map((sp) => sp.cite_key) }, single: { id: single.id, slug: single.slug, paper: toRef(sPapers[0]!) } };
}

/** A fresh in-app deck with the given Quarto source (front matter + slides). */
export async function createDeck(hub: Hub, studyId: string, title: string, slides: string): Promise<string> {
  const { id } = await hub.api<{ id: string }>("POST", "/slides", { studyId, title, kind: "progress", source: "editor" });
  const src = await hub.api<{ source: { entry: string }; files: { path: string; version: number }[] }>("GET", `/slides/${id}/source`);
  const entry = src.source?.entry ?? "index.qmd";
  const v = src.files.find((f) => f.path === entry)?.version;
  await hub.api("PUT", `/slides/${id}/source/files`, { path: entry, content: `---\ntitle: ${JSON.stringify(title)}\n---\n\n${slides}`, baseVersion: v });
  return id;
}

export async function deckSource(hub: Hub, deckId: string): Promise<string> {
  const src = await hub.api<{ source: { entry: string } | null; files: { path: string; content?: string }[] }>("GET", `/slides/${deckId}/source`);
  return src.files.find((f) => f.path === src.source?.entry)?.content ?? "";
}

// ---------------------------------------------------------------- deck sources

export const ZH_DECK_TITLE = "Zipformer + RNNT 動態熱詞：學術現況";
/** The production probe deck (6 pages, 繁中, one AI-filled and one student-owned page). */
export const ZH_DECK = `## 問題定義

- 串流語音辨識對人名、地名等罕見詞常常辨識錯誤
- 目標：不重新訓練模型，讓使用者提供的熱詞更容易被辨識出來

| 情境 | 罕見詞錯誤率 |
|---|---|
| 一般解碼 | 偏高 |
| 加入熱詞 | 待驗證 |

::: {.notes}
這一頁說明為什麼串流辨識對罕見詞特別困難，以及我們想在不重新訓練的前提下改善這個問題。
:::

## 動態熱詞的做法

\`\`\`diagram
{"type":"pipeline","stages":["語音輸入","Zipformer 編碼器","RNN-T 解碼（熱詞加權）","辨識結果"]}
\`\`\`

::: {.notes}
目前調查到的做法有 shallow fusion、TCPGen 和 contextual biasing，差別在熱詞資訊加在模型的哪個位置。
:::

## 目前進度

- 讀完 shallow fusion 與 TCPGen 的論文
- 在 icefall 上跑通 Zipformer 串流基線

| 項目 | 狀態 |
|---|---|
| 基線 | 完成 |
| 熱詞實驗 | 進行中 |

::: {.notes}
這週主要完成了基線的訓練與解碼，下週開始把熱詞清單接進解碼流程，觀察罕見詞的錯誤率變化。
:::

## 卡住

- 資料量不足：標註了熱詞的串流語料太少
- 評估指標：罕見詞錯誤率還沒有統一的算法

::: {.notes}
這週卡住的地方主要是資料與評估指標。
:::

## Idea card

- 把熱詞清單做成字首樹，在 RNN-T 解碼時加分

::: {.notes}
（報告者自己的看法）
:::

## 下週與要問

- 實作字首樹加分的 baseline
- 想問老師：罕見詞 recall 要用哪一份測試集

::: {.notes}
下週的工作與想問老師的問題。
:::
`;
export const ZH_DECK_TITLES = ["問題定義", "動態熱詞的做法", "目前進度", "卡住", "Idea card", "下週與要問"];

export const EN_DECK_TITLE = "Contextual Biasing for Streaming ASR: Where We Are";
export const EN_DECK = `## Problem

- Streaming ASR misrecognises rare words such as names and course terms
- Goal: boost user-provided hotwords without retraining the whole model

::: {.notes}
Why rare words are hard for streaming recognition and what we want to improve.
:::

## Shallow fusion

- Add a bonus to hypotheses that extend a hotword prefix tree during beam search
- No training needed; risk of false triggers on similar-sounding words

::: {.notes}
Shallow fusion is the simplest baseline and works with any decoder.
:::

## Deep context (CLAS)

- Embeds each bias phrase and attends over them from the decoder
- Trained jointly; accuracy drops when the list grows past a few hundred phrases

::: {.notes}
CLAS learns the biasing end to end but needs training data with bias lists.
:::

## Contextual adapters

- Freeze the base transducer; train a small adapter that reads the bias list
- Cheap to train and keeps the base model unchanged

::: {.notes}
Adapters are attractive for our setting because the Zipformer model stays frozen.
:::

## Current progress

| Item | Status |
|---|---|
| Zipformer streaming baseline | done |
| Hotword list (320 terms) | done |
| Shallow-fusion baseline | in progress |

::: {.notes}
This week we finished the baseline and the hotword list.
:::

## Next steps

- Implement trie-based shallow fusion
- Define rare-word recall and false-trigger rate

::: {.notes}
Next week we implement the baseline and settle the metrics.
:::
`;
export const EN_DECK_TITLES = ["Problem", "Shallow fusion", "Deep context (CLAS)", "Contextual adapters", "Current progress", "Next steps"];
