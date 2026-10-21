/**
 * Content-type detection with Google Magika's `standard_v3_3` ONNX model (vendored under `assets/magika/`).
 *
 * The feature extraction and prediction logic below is a port of Magika's reference implementation
 * (https://github.com/google/magika, Copyright Google LLC, Apache License 2.0 — see `assets/magika/LICENSE`).
 *
 * Runs on onnxruntime-web's WASM backend (single thread): the production CPU has no AVX, so the Magika CLI and
 * tfjs-node are unavailable; WASM classifies a file in ~0.1 s. The model loads lazily once and inferences run one at a
 * time (the WASM session is not re-entrant).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ContentType = {
  /** Final label after Magika's overwrite map and confidence thresholds ("txt"/"unknown" when unsure, "empty"). */
  label: string;
  score: number;
  isText: boolean;
  /** Raw argmax label of the model ("" when the model was not run). */
  modelLabel: string;
};

type MagikaConfig = {
  beg_size: number;
  end_size: number;
  block_size: number;
  padding_token: number;
  min_file_size_for_dl: number;
  medium_confidence_threshold: number;
  target_labels_space: string[];
  thresholds: Record<string, number>;
  overwrite_map: Record<string, string>;
};

/** Labels of the model that are text formats (Magika's content-types KB, `is_text: true`). */
export const MAGIKA_TEXT_LABELS: ReadonlySet<string> = new Set(
  (
    "aidl appleplist asm asp autohotkey autoit awk batch bazel bib c clojure cmake cobol coffeescript cpp cs csproj css csv " +
    "dart diff dm dockerfile dxf elixir eml erb erlang fortran gemfile gemspec gitattributes gitmodules go gradle groovy " +
    "handlebars haskell hcl htaccess html ics ignorefile ini internetshortcut ipynb java javascript jinja json jsonl julia " +
    "kotlin latex lisp lua m3u m4 makefile markdown matlab mht mum objectivec ocaml pascal pem perl php po powershell prolog " +
    "proteindb proto python r randomtxt rdf rst rtf ruby rust scala scss sgml shell smali solidity sql srt stltext sum svg " +
    "swift tcl textproto toml tsv twig txt typescript vba vcxproj verilog vhdl vtt vue winregistry xml yaml yara zig"
  ).split(" "),
);

/** `<backend>/assets/magika/standard_v3_3`: the same relative path from `src/lib/doc-import` and `dist/lib/doc-import`. */
const MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/magika/standard_v3_3");
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

type OrtModule = typeof import("onnxruntime-web");
type Session = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;
type Model = { ort: OrtModule; session: Session; config: MagikaConfig };

let modelPromise: Promise<Model> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function loadModel(): Promise<Model> {
  modelPromise ??= (async () => {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = "error";
    const [modelBytes, configText] = await Promise.all([
      readFile(path.join(MODEL_DIR, "model.onnx")),
      readFile(path.join(MODEL_DIR, "config.min.json"), "utf8"),
    ]);
    const session = await ort.InferenceSession.create(new Uint8Array(modelBytes));
    return { ort, session, config: JSON.parse(configText) as MagikaConfig };
  })().catch((error) => {
    modelPromise = null; // allow a retry after a transient failure
    throw error;
  });
  return modelPromise;
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Magika's features: stripped first `beg_size` bytes, padding, stripped last `end_size` bytes (right-aligned). */
export function magikaFeatures(bytes: Uint8Array, cfg: Pick<MagikaConfig, "beg_size" | "end_size" | "block_size" | "padding_token">) {
  const head = bytes.subarray(0, Math.min(cfg.block_size, bytes.length));
  let i = 0;
  while (i < head.length && WHITESPACE.has(head[i]!)) i++;
  const beg = head.subarray(i, i + cfg.beg_size);
  const tail = bytes.subarray(Math.max(0, bytes.length - cfg.block_size));
  let j = tail.length;
  while (j > 0 && WHITESPACE.has(tail[j - 1]!)) j--;
  const end = tail.subarray(Math.max(0, j - cfg.end_size), j);
  const out = new Int32Array(cfg.beg_size + cfg.end_size).fill(cfg.padding_token);
  out.set(beg, 0);
  out.set(end, cfg.beg_size + cfg.end_size - end.length);
  return { features: out, begLength: beg.length };
}

function smallFile(bytes: Uint8Array): ContentType {
  return isUtf8(bytes) ? { label: "txt", score: 1, isText: true, modelLabel: "" } : { label: "unknown", score: 1, isText: false, modelLabel: "" };
}

async function infer(bytes: Uint8Array): Promise<ContentType> {
  if (bytes.length === 0) return { label: "empty", score: 1, isText: false, modelLabel: "" };
  const { ort, session, config } = await loadModel();
  if (bytes.length < config.min_file_size_for_dl) return smallFile(bytes);
  const { features, begLength } = magikaFeatures(bytes, config);
  if (begLength < config.min_file_size_for_dl) return smallFile(bytes); // (almost) only whitespace
  const input = new ort.Tensor("int32", features, [1, features.length]);
  const output = await session.run({ [session.inputNames[0]!]: input });
  const scores = output[session.outputNames[0]!]!.data as Float32Array;
  let best = 0;
  for (let k = 1; k < scores.length; k++) if (scores[k]! > scores[best]!) best = k;
  const modelLabel = config.target_labels_space[best] ?? "unknown";
  const score = scores[best] ?? 0;
  let label = config.overwrite_map[modelLabel] ?? modelLabel;
  const threshold = config.thresholds[modelLabel] ?? config.medium_confidence_threshold;
  if (score < threshold) label = MAGIKA_TEXT_LABELS.has(modelLabel) ? "txt" : "unknown";
  return { label, score, isText: label === "txt" || MAGIKA_TEXT_LABELS.has(label), modelLabel };
}

/** Classifies `bytes` (whole file; only the first/last 4 KB are read). Inferences are serialized. */
export function detectContentType(bytes: Uint8Array): Promise<ContentType> {
  const run = queue.then(() => infer(bytes));
  queue = run.catch(() => undefined);
  return run;
}
