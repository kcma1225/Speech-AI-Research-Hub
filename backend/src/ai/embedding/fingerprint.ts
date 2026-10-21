/**
 * Embedding identity fingerprint. A fixed probe set is embedded by a model; another model or deployment is the
 * "same identity" when it reproduces those vectors (cosine of every probe ≥ 0.95, same dimension). Same model on
 * another server/quantisation scores ≈ 0.99; a different model scores near 0, so its vectors cannot be mixed.
 */

export const FINGERPRINT_VERSION = 1;
export const SAME_IDENTITY_MIN_COSINE = 0.95;

/** Never change in place: add a new version (old fingerprints keep their own version). */
export const FINGERPRINT_PROBES: Record<number, string[]> = {
  1: [
    "語音情緒辨識使用自監督學習的語音表徵。",
    "Speaker diarization assigns speech segments to speakers.",
    "指導教授建議下週前完成文獻探討的初稿。",
    "The model was fine-tuned on 100 hours of Mandarin speech.",
    "實驗結果顯示字錯誤率下降了百分之十二。",
    "Attention is all you need.",
    "會議紀錄：資料前處理流程需要重新設計。",
    "Taiwanese Hokkien code-switching remains a challenge for ASR.",
  ],
};

export const probesFor = (version = FINGERPRINT_VERSION) => FINGERPRINT_PROBES[version]!;

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export type FingerprintComparison = { same: boolean; sameDims: boolean; dims: [number, number]; minCosine: number; meanCosine: number };

export function compareFingerprints(stored: number[][], candidate: number[][], threshold = SAME_IDENTITY_MIN_COSINE): FingerprintComparison {
  const dims: [number, number] = [stored[0]?.length ?? 0, candidate[0]?.length ?? 0];
  const sameDims = dims[0] === dims[1] && dims[0] > 0 && stored.length === candidate.length;
  if (!sameDims) return { same: false, sameDims, dims, minCosine: 0, meanCosine: 0 };
  const scores = stored.map((v, i) => cosine(v, candidate[i]!));
  const minCosine = Math.min(...scores);
  const meanCosine = scores.reduce((s, x) => s + x, 0) / scores.length;
  return { same: minCosine >= threshold, sameDims, dims, minCosine: round(minCosine), meanCosine: round(meanCosine) };
}

const round = (x: number) => Math.round(x * 10000) / 10000;

/** Compact storage: 6 significant digits are plenty for a ≥ 0.95 comparison. */
export const compactVectors = (vs: number[][]) => vs.map((v) => v.map((x) => Number(x.toPrecision(6))));
