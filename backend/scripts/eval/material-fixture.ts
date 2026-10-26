/**
 * A synthetic Deep-Research-style result (Markdown) the material eval task and scenario cases attach to the chat
 * (production 301b6e1a class: the user's attached research result must be the deck's main material). Every name and
 * number here is invented for the fixture; the graders look for its unique tokens (MedReg-TW, 1,240 句, 61.3%, 38 個門診科別)
 * in the deck to tell whether the material was used. Not production text.
 */
export const MATERIAL_FILE = "deep_research_medreg_hotword.md";

/** Tokens only the fixture has (a deck that used the material mentions several of them). */
export const MATERIAL_TOKENS: string[][] = [["MedReg-TW"], ["1,240", "1240"], ["61.3"], ["38 個門診", "38 個科別", "38 個"], ["2.7%", "2.7"], ["Zipformer-S"], ["掛號專線"], ["醫師姓名"]];

/** The parts the eval request lists (each must get its own page). */
export const MATERIAL_SECTIONS = ["研究背景", "既有資源與限制", "候選研究方向", "優先順序", "最小可行研究設計", "需要教授決策的問題"];

export const MATERIAL_REQUEST =
  "我已經有一個 deep research 的結果（附件），幫我以此做成能像教授報告的簡報：清楚區分已知事實、合理推論與待驗證構想，呈現研究背景、既有資源與限制、候選研究方向、優先順序、最小可行研究設計與需要教授決策的問題";

export const DEEP_RESEARCH_MD = `# Deep Research：醫院掛號電話的串流語音辨識——門診科別與醫師姓名的熱詞偏置

> 產生方式：deep research 工具（多輪搜尋＋整理），研究生自行校對。標記說明：【事實】有出處的已知事實；【推論】由事實合理推得；【待驗證】還沒有證據的構想。

## 1. 研究背景

- 【事實】本院掛號專線（測試情境：一家大型醫學中心）每天約 4,500 通來電，其中 62% 在說出「科別＋醫師姓名」後轉人工。
- 【事實】現行的商用 ASR 在醫師姓名上的錯誤最多：抽樣 300 通電話，醫師姓名的 CER 為 23.8%，一般詞彙 CER 為 7.1%。
- 【推論】醫師姓名與門診科別是封閉、會變動的清單（每月排班更新），適合用熱詞偏置（contextual biasing）而不是重新訓練整個模型。
- 【待驗證】如果醫師姓名辨識正確，轉人工的比例可以降到 30% 以下。

## 2. 既有資源

- 【事實】MedReg-TW：本實驗室整理的掛號語音測試集，1,240 句，含 38 個門診科別、412 位醫師姓名，標注了熱詞位置。
- 【事實】基礎模型：Zipformer-S（26M 參數）串流 RNN-T，在 MedReg-TW 一般詞彙 CER 8.4%。
- 【事實】現有的熱詞做法：icefall 的 shallow fusion（ContextGraph），在 MedReg-TW 的罕見詞 recall 為 61.3%，誤觸發率 2.7%。
- 【事實】GPU：一張 RTX 4090（24 GB），實驗室共用。

## 3. 限制與風險

- 【事實】病患資料受個資法保護：錄音只能在院內伺服器處理，不能上傳雲端 API。
- 【事實】MedReg-TW 只有 1,240 句，訓練用的掛號語音沒有現成的資料。
- 【推論】只靠 1,240 句無法訓練神經式偏置模組，需要合成資料（TTS）或從一般語料造句。
- 【待驗證】台語夾雜的醫師姓名（例如台語念法）佔比可能超過 10%，目前沒有統計。

## 4. 候選研究方向

1. 方向 A：調整 shallow fusion 的熱詞權重與 ContextGraph（只在推論時加，不需要訓練）。
   - 【推論】成本最低，一週內可以有結果；但罕見詞 recall 的上限可能只到 70% 左右。
2. 方向 B：在 Zipformer-S 的 encoder 後加 contextual adapter，用 TTS 合成的掛號句訓練。
   - 【推論】recall 可能提升較多，但需要 2–3 週準備合成資料與訓練。
   - 【待驗證】合成語音和真實電話語音的差距會不會讓 adapter 失效。
3. 方向 C：辨識後用醫師名單做 N-best 重排序（後處理）。
   - 【推論】不動模型、容易部署；但第一遍完全沒聽到的姓名救不回來。

## 5. 優先順序（建議）

1. 先做方向 A，建立 MedReg-TW 上的可重現 baseline（罕見詞 recall、誤觸發率、延遲）。
2. 再做方向 C，和 A 疊加。
3. 方向 B 視 A＋C 的結果與教授決定再開始。

## 6. 最小可行研究設計（MVP）

- 資料：MedReg-TW 1,240 句（固定 test split 400 句），醫師名單 412 人、38 個門診科別。
- 比較：無偏置 baseline、方向 A、A＋C。
- 指標：罕見詞 recall、誤觸發率（false alarm）、一般詞彙 CER、首字延遲（ms）。
- 成功標準（【待驗證】的目標）：罕見詞 recall ≥ 75%，誤觸發率 ≤ 3%，一般詞彙 CER 不變差超過 0.3 個百分點。
- 時程：兩週（第一週 A，第二週 C 與分析）。

## 7. 需要教授決定的問題

- 是否同意先做不需訓練的方向 A／C，方向 B 延後？
- 醫院端能不能提供更多真實掛號錄音（需要 IRB）？
- 台語念法的醫師姓名要不要列入這一期的範圍？
- 論文要投 Interspeech（3 月截稿）還是先投國內研討會？

## 8. 參考來源（deep research 摘錄）

- icefall ContextGraph 文件與 shallow fusion 範例。
- 本實驗室 2025 年 MedReg-TW 標注說明。
- 醫院資訊室提供的 2025 年 Q3 掛號專線統計。
`;

/** A minimal one-page PDF (Helvetica, Latin text only) for 「用我上傳的 PDF」 cases: the bytes doc-import extracts text from. */
export function minimalPdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 12 Tf 50 780 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** The English lab-notes PDF of the 「用我上傳的 PDF」 scenario. */
export const PDF_NOTES = [
  "Lab notes: MedReg-TW hotword biasing, week 3",
  "Baseline Zipformer-S streaming RNN-T: general CER 8.4 percent on MedReg-TW (1240 utterances).",
  "Shallow fusion with ContextGraph: rare-word recall 61.3 percent, false alarm rate 2.7 percent.",
  "N-best rescoring with the doctor list: recall 66.0 percent, false alarms 2.9 percent.",
  "Open issue: Taiwanese pronunciations of doctor names are not in the hotword list.",
  "Next: tune the boosting score per department (38 departments) and measure first-token latency.",
];

/** Pasted notes (several paragraphs) for the 「貼上的筆記」 scenario. */
export const PASTED_NOTES = `下面是我這兩週的實驗筆記：

第一週：在 MedReg-TW（1,240 句）上重跑 Zipformer-S baseline，一般詞彙 CER 8.4%。加上 shallow fusion（ContextGraph，boosting score 2.0）後罕見詞 recall 從 38.5% 到 61.3%，誤觸發率 2.7%。

第二週：試了把 boosting score 依門診科別調整（38 個科別各自一組權重），罕見詞 recall 到 64.8%，但誤觸發率升到 3.4%。另外用醫師名單做 N-best 重排序，recall 66.0%，誤觸發 2.9%。

錯誤分析：抽 200 句看錯誤，醫師姓名錯在同音字（例如「陳怡君」被辨識成「陳宜君」）的有 41 句，科別名稱錯的只有 6 句，大多是「身心科」和「心臟科」互相混淆；把醫師名單依科別分組後，同音字錯誤少了一半左右，但名單更新時要重建 ContextGraph，大約要 3 分鐘。

問題：台語念法的醫師姓名完全沒有被辨識出來；首字延遲從 180 ms 增加到 230 ms。

幫我把上面的筆記做成簡報`;
