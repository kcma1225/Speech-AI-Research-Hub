/**
 * Requirement probe against a running hub (staging, cheap model): the production failure as a script.
 *   1. a Chinese progress deck → 「整份改成英文」 (autopilot) → expect English everywhere incl. the cover;
 *   2. follow-up 「再詳細一點，每個方法要有架構、Pros/Cons」 without repeating the language → expect English kept,
 *      expand mode and the per-item fields on the item pages.
 * Prints the plan's requirements, criteria results and any Chinese left (requirements.ts `languageViolations`).
 * Never point it at production.
 *
 *   HUB_URL=http://127.0.0.1:18090 HUB_USER=chenbaiyu HUB_PASSWORD=password123 npx tsx scripts/probe-requirements.ts [translate|followup|all] [deckId]
 */
import { languageViolations } from "../src/workflows/requirements.js";

const HUB = (process.env.HUB_URL ?? "http://127.0.0.1:18090").replace(/\/+$/, "");
if (/speech-ai-hub\.gugulu\.tw/.test(HUB)) throw new Error("Refusing to probe production.");
const origin = new URL(HUB).origin;
let cookie = "";

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  // Staging may be redeployed while a probe waits: retry connection errors for a few minutes.
  let res: Response | null = null;
  for (let i = 0; !res; i++) {
    try {
      res = await fetch(`${HUB}/api${path}`, { method, headers: { origin, cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data.code ?? ""} ${data.error ?? ""}`);
  return data as T;
}

const CHINESE_DECK = `## 問題定義

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

[AI 代填，待你確認]{.hub-ai-filled style="color:#b45309;font-weight:600;font-size:0.7em"}

- 資料量不足：標註了熱詞的串流語料太少
- 評估指標：罕見詞錯誤率還沒有統一的算法

::: {.notes}
（AI 代填，待你確認：自動駕駛依研究資料草擬的建議，不是報告者確認過的看法；報告前請確認或改寫成自己的想法。）
:::

## Idea card

- 把熱詞清單做成字首樹，在 RNN-T 解碼時加分

::: {.notes}
（報告者自己的看法，依報告者在工作流程中確認的回答整理）
:::

## 下週與要問

〔　這頁留給你自己寫：之後補上你的想法　〕

::: {.notes}
（由報告者補充）
:::
`;

type Wf = { id: string; status: string; plan: { requirements?: { type: string; text: string; source: string }[]; edit_kind?: string; front_title?: string } | null; criteria: { id: string; text: string; status: string; reason?: string }[]; artifacts: { kind: string; id: string; title: string }[]; report: { summary_md: string } | null };

async function waitRun(id: string): Promise<Wf> {
  const t0 = Date.now();
  let last = "";
  for (;;) {
    const { workflow } = await api<{ workflow: Wf }>("GET", `/workflows/${id}`);
    if (workflow.status !== last) console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${workflow.status}`);
    last = workflow.status;
    if (["done", "partial", "failed", "cancelled"].includes(workflow.status)) return workflow;
    if (workflow.status === "awaiting_plan_approval") await api("POST", `/workflows/${id}/approve`, {});
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function deckSource(deckId: string): Promise<string> {
  const src = await api<{ source: { entry: string }; files: { path: string; content?: string }[] }>("GET", `/slides/${deckId}/source`);
  return src.files.find((f) => f.path === src.source.entry)?.content ?? "";
}

function report(label: string, w: Wf, qmd: string) {
  console.log(`\n== ${label}: ${w.status} (${w.id})`);
  console.log(`  requirements: ${(w.plan?.requirements ?? []).map((r) => `${r.type}${r.source === "standing" ? "（沿用）" : ""}: ${r.text}`).join(" | ") || "(none)"}`);
  if (w.plan?.edit_kind) console.log(`  edit kind: ${w.plan.edit_kind}${w.plan.front_title ? `, cover: ${w.plan.front_title}` : ""}`);
  for (const c of w.criteria) console.log(`  [${c.status}] ${c.id} ${c.text.slice(0, 70)}${c.status !== "pass" && c.reason ? ` — ${c.reason.slice(0, 160)}` : ""}`);
  const left = languageViolations(qmd, "en");
  console.log(`  Chinese left in the deck source: ${left.length ? left.map((v) => `p${v.page} ${v.part} 「${v.snippet}」`).join("; ") : "none"}`);
  console.log(`  cover line: ${qmd.split("\n").find((l) => l.startsWith("title:")) ?? "?"}`);
}

const mode = process.argv[2] ?? "all";
await api("POST", "/auth/login", { username: process.env.HUB_USER ?? "chenbaiyu", password: process.env.HUB_PASSWORD ?? "password123" });
const studies = await api<{ studies: { id: string; title: string }[] }>("GET", "/studies?scope=mine");
const study = studies.studies.find((s) => !process.env.PROBE_STUDY || s.title.includes(process.env.PROBE_STUDY)) ?? studies.studies[0];
if (!study) throw new Error("The user has no study.");
const conv = (await api<{ conversation: { id: string } }>("POST", "/agent/conversations", {})).conversation.id;
let deckId = process.argv[3] ?? "";

if (mode === "translate" || mode === "all") {
  const { id } = await api<{ id: string }>("POST", "/slides", { studyId: study.id, title: "Zipformer + RNNT 動態熱詞：學術現況", kind: "progress", source: "editor" });
  const src = await api<{ files: { path: string; version: number }[] }>("GET", `/slides/${id}/source`);
  const v = src.files.find((f) => f.path === "index.qmd")?.version;
  await api("PUT", `/slides/${id}/source/files`, { path: "index.qmd", content: `---\ntitle: "Zipformer + RNNT 動態熱詞：學術現況"\n---\n\n${CHINESE_DECK}`, baseVersion: v });
  console.log(`Chinese deck ${id} in 〈${study.title}〉; conversation ${conv}`);
  const { workflow } = await api<{ workflow: Wf }>("POST", "/workflows", { request: process.env.PROBE_REQUEST ?? "全英文翻譯", conversation_id: conv, inputs: { study: study.id, deck_id: id }, autopilot: true });
  const w = await waitRun(workflow.id);
  deckId = w.artifacts.find((a) => a.kind === "deck")?.id ?? id;
  report("translate", w, await deckSource(deckId));
}
if (mode === "followup" || mode === "all") {
  if (!deckId) throw new Error("followup needs a deck id (argv[3]) or the translate step.");
  const { workflow } = await api<{ workflow: Wf }>("POST", "/workflows", { request: "還不夠細，再詳細一點，focus 在動態熱詞，每個方法要有架構、Pros/Cons", conversation_id: conv, inputs: { study: study.id, deck_id: deckId }, autopilot: true });
  const w = await waitRun(workflow.id);
  const out = w.artifacts.find((a) => a.kind === "deck")?.id ?? deckId;
  report("follow-up", w, await deckSource(out));
}
