/**
 * ```diagram JSON spec of generated decks: parsing + validation (lenient with model output: aliases, missing ids,
 * string nodes) with problems reported in zh-TW for the writer. See `DIAGRAM_SPEC_HELP` for the format the writers get.
 */
export const DIAGRAM_TYPES = ["pipeline", "architecture", "encoder_decoder", "comparison", "cycle", "timeline", "tree", "graph", "grid"] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];
export const NODE_KINDS = ["input", "process", "model", "data", "output", "highlight", "note"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const ICONS = ["waveform", "spectrogram", "transformer", "attention", "embedding", "tokens", "text", "database", "probe", "chart", "layers", "mic", "loss", "align", "cluster", "subspace", "speaker", "gear", "image", "check"] as const;
export type IconName = (typeof ICONS)[number];
export type EdgeKind = "flow" | "skip" | "residual" | "feedback" | "cross" | "gradient";
export type EdgeStyle = "solid" | "dashed" | "dotted";

export type DNode = { id: string; label: string; sub?: string; kind: NodeKind; icon?: IconName; badge?: string; repeat?: string; frozen?: boolean; trainable?: boolean; shape?: "box" | "pill" | "cylinder" | "circle"; side?: "left" | "right" };
export type DEdge = { from: string; to: string; label?: string; style: EdgeStyle; kind: EdgeKind; both?: boolean };
export type DGroup = { label?: string; nodes: string[]; style: "default" | "frozen" | "highlight" | "plain" };
/** A layer of an architecture stack: one block, a row of blocks, or a repeated block (× N). */
export type DLayer = { node: string } | { row: string[] } | { repeat: string; label?: string; layers: DLayer[] };
export type DPanel = { title: string; sub?: string; highlight?: boolean; stages: string[][]; edges?: DEdge[] };
export type DEvent = { id: string; label: string; date?: string; sub?: string; kind: NodeKind };
export type DTree = { id: string; children: DTree[] };
export type DLegend = { kind?: NodeKind | "frozen" | "trainable"; style?: EdgeStyle; label: string };

export type DiagramSpec = {
  type: DiagramType;
  title?: string;
  caption?: string;
  direction: "LR" | "TB";
  /** architecture: bottom → top ("up", the usual model figure) or top → bottom. */
  flow: "up" | "down";
  nodes: Map<string, DNode>;
  edges: DEdge[];
  groups: DGroup[];
  /** pipeline: columns of node ids (parallel nodes share a stage). */
  stages: string[][];
  layers: DLayer[];
  /** encoder_decoder towers. */
  towers: { title?: string; layers: DLayer[] }[];
  panels: DPanel[];
  events: DEvent[];
  tree?: DTree;
  center?: string;
  legend: DLegend[] | boolean;
  /** Edges were given explicitly (no automatic chaining). */
  explicitEdges: boolean;
  /** grid: columns (auto when absent). */
  cols?: number;
};

export type ParsedDiagram = { spec: DiagramSpec | null; problems: string[] };

const KIND_ALIAS: Record<string, NodeKind> = { input: "input", in: "input", source: "input", process: "process", step: "process", op: "process", operation: "process", module: "process", model: "model", network: "model", encoder: "model", decoder: "model", block: "model", layer: "model", data: "data", dataset: "data", database: "data", feature: "data", features: "data", output: "output", out: "output", result: "output", target: "output", highlight: "highlight", ours: "highlight", novel: "highlight", proposed: "highlight", contribution: "highlight", key: "highlight", note: "note", comment: "note" };
const ICON_ALIAS: Record<string, IconName> = { wave: "waveform", audio: "waveform", speech: "waveform", waveform: "waveform", spec: "spectrogram", mel: "spectrogram", spectrogram: "spectrogram", fbank: "spectrogram", transformer: "transformer", encoder: "transformer", decoder: "transformer", block: "transformer", attention: "attention", attn: "attention", heads: "attention", embedding: "embedding", vector: "embedding", representation: "embedding", hidden: "embedding", tokens: "tokens", token: "tokens", words: "tokens", text: "text", document: "text", transcript: "text", database: "database", db: "database", dataset: "database", data: "database", probe: "probe", search: "probe", classifier: "probe", chart: "chart", plot: "chart", metric: "chart", layers: "layers", stack: "layers", mic: "mic", microphone: "mic", loss: "loss", objective: "loss", align: "align", alignment: "align", cluster: "cluster", clusters: "cluster", kmeans: "cluster", subspace: "subspace", orthogonal: "subspace", projection: "subspace", speaker: "speaker", person: "speaker", user: "speaker", gear: "gear", process: "gear", image: "image", figure: "image", check: "check", eval: "check", evaluation: "check" };

const s = (v: unknown, n: number) => (typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, n) : "");
const LABEL_MAX = 64;
const MAX_NODES = 18;

export function parseDiagram(source: string): ParsedDiagram {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (e) {
    return { spec: null, problems: [`diagram 不是有效的 JSON：${(e as Error).message.slice(0, 80)}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { spec: null, problems: ["diagram 必須是一個 JSON 物件"] };
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  const t = s(r.type, 30).toLowerCase().replace(/[-\s]/g, "_");
  const type: DiagramType | null = (DIAGRAM_TYPES as readonly string[]).includes(t) ? (t as DiagramType) : /flow|pipe|process/.test(t) ? "pipeline" : /arch|stack|model/.test(t) ? "architecture" : /enc.*dec|seq2seq/.test(t) ? "encoder_decoder" : /compar|versus|vs/.test(t) ? "comparison" : /cycle|loop/.test(t) ? "cycle" : /time/.test(t) ? "timeline" : /tree|taxonomy|hierarch/.test(t) ? "tree" : /graph|network|dag/.test(t) ? "graph" : /grid|group|list|cards?|set|matrix/.test(t) ? "grid" : null;
  if (!type) return { spec: null, problems: [`未知的 diagram type「${t || "（空）"}」；可用：${DIAGRAM_TYPES.join(" / ")}`] };
  const nodes = new Map<string, DNode>();
  let auto = 0;
  const addNode = (v: unknown, fallbackKind: NodeKind = "process"): string | null => {
    if (typeof v === "string" || typeof v === "number") {
      const label = s(v, 200);
      if (!label) return null;
      // A bare string that names an existing node is a reference.
      if (nodes.has(label)) return label;
      for (const n of nodes.values()) if (n.label === label) return n.id;
      return addNode({ label }, fallbackKind);
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    let label = s(o.label ?? o.name ?? o.text ?? o.title, 200);
    const id0 = s(o.id, 40);
    if (!label && id0 && nodes.has(id0)) return id0;
    if (!label) label = id0;
    if (!label) return null;
    if (label.replace(/\$[^$]*\$/g, "x").length > LABEL_MAX) {
      problems.push(`節點標籤太長（${label.slice(0, 30)}…）：請 ≤ 5 個英文字或 12 個中文字，細節放 sub`);
      label = label.slice(0, LABEL_MAX);
    }
    let id = id0 || label.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "_").slice(0, 30) || `n${++auto}`;
    if (!id0) while (nodes.has(id)) id = `${id}_${++auto}`;
    if (nodes.has(id)) return id;
    const kind = KIND_ALIAS[s(o.kind ?? o.type ?? o.role, 20).toLowerCase()] ?? (o.highlight === true || o.ours === true || o.novel === true ? "highlight" : fallbackKind);
    const icon = ICON_ALIAS[s(o.icon, 20).toLowerCase()];
    const rep = o.repeat ?? o.times ?? o.n;
    const shape = s(o.shape, 12).toLowerCase();
    nodes.set(id, {
      id,
      label,
      ...(s(o.sub ?? o.sublabel ?? o.detail ?? o.desc, 90) ? { sub: s(o.sub ?? o.sublabel ?? o.detail ?? o.desc, 90) } : {}),
      kind,
      ...(icon ? { icon } : {}),
      ...(s(o.badge, 16) ? { badge: s(o.badge, 16) } : {}),
      ...(rep !== undefined && s(rep, 8) ? { repeat: s(rep, 8).replace(/^[x×]\s*/i, "") } : {}),
      ...(o.frozen === true ? { frozen: true } : {}),
      ...(o.trainable === true || o.trained === true ? { trainable: true } : {}),
      ...(["box", "pill", "cylinder", "circle"].includes(shape) ? { shape: shape as DNode["shape"] } : {}),
      ...(o.side === "left" || o.side === "right" ? { side: o.side } : {}),
    });
    return id;
  };

  // Pre-register top-level nodes (graph / architecture side nodes / pipeline nodes list).
  const nodeList = Array.isArray(r.nodes) ? (r.nodes as unknown[]) : [];
  const listed = nodeList.map((n) => addNode(n)).filter((x): x is string => !!x);

  const edgeOf = (v: unknown): DEdge | null => {
    if (Array.isArray(v) && v.length >= 2) return edgeOf({ from: v[0], to: v[1], label: v[2] });
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const from = refOf(o.from ?? o.source ?? o.src);
    const to = refOf(o.to ?? o.target ?? o.dst);
    if (!from || !to) {
      problems.push(`連線 ${s(o.from ?? o.source, 20) || "?"} → ${s(o.to ?? o.target, 20) || "?"} 指到不存在的節點`);
      return null;
    }
    const kind0 = s(o.kind ?? o.type, 16).toLowerCase();
    const kind: EdgeKind = /skip|shortcut/.test(kind0) ? "skip" : /resid/.test(kind0) ? "residual" : /feed|back|loop/.test(kind0) ? "feedback" : /cross/.test(kind0) ? "cross" : /grad/.test(kind0) ? "gradient" : "flow";
    const st = s(o.style, 10).toLowerCase();
    const label = s(o.label ?? o.text, 60);
    return { from, to, ...(label ? { label } : {}), style: st === "dashed" || st === "dotted" ? st : kind === "gradient" || kind === "feedback" ? "dashed" : "solid", kind, ...(o.both === true || o.bidirectional === true ? { both: true } : {}) };
  };
  const refOf = (v: unknown): string | null => {
    const k = s(v, 200);
    if (!k) return null;
    if (nodes.has(k)) return k;
    for (const n of nodes.values()) if (n.label === k) return n.id;
    const low = k.toLowerCase();
    for (const n of nodes.values()) if (n.id.toLowerCase() === low || n.label.toLowerCase() === low) return n.id;
    return null;
  };

  const stageOf = (v: unknown, kind?: NodeKind): string[] => (Array.isArray(v) ? v.map((x) => addNode(x, kind)).filter((x): x is string => !!x) : [addNode(v, kind)].filter((x): x is string => !!x));

  const layersOf = (v: unknown, depth = 0): DLayer[] => {
    if (!Array.isArray(v)) return [];
    const out: DLayer[] = [];
    for (const item of v) {
      if (Array.isArray(item)) {
        const row = stageOf(item, "model");
        if (row.length) out.push(row.length === 1 ? { node: row[0]! } : { row });
      } else if (item && typeof item === "object" && Array.isArray((item as { row?: unknown }).row)) {
        const row = stageOf((item as { row: unknown[] }).row, "model");
        if (row.length) out.push({ row });
      } else if (item && typeof item === "object" && Array.isArray((item as { layers?: unknown }).layers) && depth < 2) {
        const o = item as Record<string, unknown>;
        out.push({ repeat: s(o.repeat ?? o.times ?? o.n ?? "", 8).replace(/^[x×]\s*/i, ""), ...(s(o.label ?? o.title, 40) ? { label: s(o.label ?? o.title, 40) } : {}), layers: layersOf(o.layers, depth + 1) });
      } else {
        const id = addNode(item, "model");
        if (id) out.push({ node: id });
      }
    }
    return out;
  };

  let stages: string[][] = [];
  let layers: DLayer[] = [];
  const towers: DiagramSpec["towers"] = [];
  const panels: DPanel[] = [];
  const events: DEvent[] = [];
  let tree: DTree | undefined;

  if (type === "pipeline") {
    if (Array.isArray(r.stages)) stages = (r.stages as unknown[]).map((x) => (x && typeof x === "object" && !Array.isArray(x) && Array.isArray((x as { nodes?: unknown }).nodes) ? stageOf((x as { nodes: unknown[] }).nodes) : stageOf(x))).filter((x) => x.length);
    else {
      for (const [i, id] of listed.entries()) {
        const parallel = (nodeList[i] as { parallel?: unknown } | undefined)?.parallel === true;
        if (parallel && stages.length) stages.at(-1)!.push(id);
        else stages.push([id]);
      }
    }
    if (!stages.length) problems.push("pipeline 需要 stages（或 nodes）");
  } else if (type === "architecture") {
    layers = layersOf(r.layers ?? r.stack ?? r.blocks);
    if (!layers.length) problems.push("architecture 需要 layers");
  } else if (type === "encoder_decoder") {
    for (const key of ["encoder", "decoder"]) {
      const t0 = r[key] as Record<string, unknown> | unknown[] | undefined;
      const ls = Array.isArray(t0) ? layersOf(t0) : t0 && typeof t0 === "object" ? layersOf((t0 as Record<string, unknown>).layers) : [];
      const title = Array.isArray(t0) ? (key === "encoder" ? "Encoder" : "Decoder") : s((t0 as Record<string, unknown> | undefined)?.title ?? (key === "encoder" ? "Encoder" : "Decoder"), 40);
      towers.push({ title, layers: ls });
    }
    if (towers.some((x) => !x.layers.length)) problems.push("encoder_decoder 需要 encoder.layers 與 decoder.layers");
  } else if (type === "comparison") {
    const list = (Array.isArray(r.panels) ? r.panels : Array.isArray(r.columns) ? r.columns : Array.isArray(r.approaches) ? r.approaches : []) as unknown[];
    for (const p of list.slice(0, 4)) {
      if (!p || typeof p !== "object") continue;
      const o = p as Record<string, unknown>;
      const st = (Array.isArray(o.stages) ? o.stages : Array.isArray(o.nodes) ? o.nodes : Array.isArray(o.steps) ? o.steps : []) as unknown[];
      const pstages = st.map((x) => stageOf(x)).filter((x) => x.length);
      const pedges = Array.isArray(o.edges) ? (o.edges as unknown[]).map(edgeOf).filter((e): e is DEdge => !!e) : undefined;
      panels.push({ title: s(o.title ?? o.label ?? o.name, 50) || `#${panels.length + 1}`, ...(s(o.sub ?? o.subtitle, 70) ? { sub: s(o.sub ?? o.subtitle, 70) } : {}), ...(o.highlight === true || o.ours === true ? { highlight: true } : {}), stages: pstages, ...(pedges?.length ? { edges: pedges } : {}) });
    }
    if (panels.length < 2) problems.push("comparison 需要至少 2 個 panels");
  } else if (type === "cycle") {
    if (listed.length < 3) problems.push("cycle 需要 3–8 個 nodes");
  } else if (type === "timeline") {
    const list = (Array.isArray(r.events) ? r.events : nodeList) as unknown[];
    for (const e of list.slice(0, 10)) {
      const o = (typeof e === "string" ? { label: e } : e) as Record<string, unknown>;
      if (!o || typeof o !== "object") continue;
      const id = addNode({ ...o, kind: o.kind ?? "process" });
      if (!id) continue;
      const kind = nodes.get(id)!.kind;
      events.push({ id, label: nodes.get(id)!.label, ...(s(o.date ?? o.time ?? o.year ?? o.at, 24) ? { date: s(o.date ?? o.time ?? o.year ?? o.at, 24) } : {}), ...(nodes.get(id)!.sub ? { sub: nodes.get(id)!.sub } : {}), kind });
    }
    if (events.length < 2) problems.push("timeline 需要至少 2 個 events");
  } else if (type === "tree") {
    const walk = (v: unknown, depth: number): DTree | null => {
      const id = addNode(v, depth === 0 ? "model" : "process");
      if (!id) return null;
      const kids = v && typeof v === "object" && Array.isArray((v as { children?: unknown }).children) && depth < 3 ? ((v as { children: unknown[] }).children.map((c) => walk(c, depth + 1)).filter(Boolean) as DTree[]) : [];
      return { id, children: kids.slice(0, 8) };
    };
    tree = walk(r.root ?? r.tree, 0) ?? undefined;
    if (!tree) problems.push("tree 需要 root（含 children）");
  } else if (type === "graph") {
    if (!listed.length) problems.push("graph 需要 nodes");
  } else if (type === "grid") {
    // Parallel items (applications, datasets, compared systems): `nodes` or `items`, no arrows.
    if (!listed.length && Array.isArray(r.items)) for (const x of r.items as unknown[]) addNode(x);
    if (!nodes.size) problems.push("grid 需要 nodes");
  }

  const edges = Array.isArray(r.edges) ? (r.edges as unknown[]).map(edgeOf).filter((e): e is DEdge => !!e) : [];
  const groups: DGroup[] = [];
  if (Array.isArray(r.groups)) {
    for (const g of (r.groups as unknown[]).slice(0, 6)) {
      if (!g || typeof g !== "object") continue;
      const o = g as Record<string, unknown>;
      const ids = (Array.isArray(o.nodes) ? (o.nodes as unknown[]) : []).map(refOf).filter((x): x is string => !!x);
      if (!ids.length) continue;
      const st = s(o.style ?? o.kind, 12).toLowerCase();
      groups.push({ ...(s(o.label ?? o.title, 40) ? { label: s(o.label ?? o.title, 40) } : {}), nodes: ids, style: st === "frozen" || st === "highlight" || st === "plain" ? st : /ours|novel|propos/.test(st) ? "highlight" : "default" });
    }
  }
  if (nodes.size > MAX_NODES) problems.push(`節點太多（${nodes.size} 個）：一張圖 ≤ 12 個節點最清楚，請合併或拆成兩張`);
  if (!nodes.size) return { spec: null, problems: [...problems, "diagram 沒有任何節點"] };
  let legend: DiagramSpec["legend"] = true;
  if (r.legend === false) legend = false;
  else if (Array.isArray(r.legend)) {
    legend = (r.legend as unknown[])
      .map((l) => (l && typeof l === "object" ? (l as Record<string, unknown>) : null))
      .filter((l): l is Record<string, unknown> => !!l && !!s(l.label, 40))
      .map((l) => ({ label: s(l.label, 40), ...(KIND_ALIAS[s(l.kind, 20).toLowerCase()] ? { kind: KIND_ALIAS[s(l.kind, 20).toLowerCase()] } : s(l.kind, 20) === "frozen" || s(l.kind, 20) === "trainable" ? { kind: s(l.kind, 20) as "frozen" | "trainable" } : {}), ...(s(l.style, 10) === "dashed" || s(l.style, 10) === "dotted" ? { style: s(l.style, 10) as EdgeStyle } : {}) }))
      .slice(0, 5);
  }
  const dir = s(r.direction ?? r.dir ?? r.orientation, 10).toUpperCase();
  const flow = s(r.flow, 6).toLowerCase();
  const spec: DiagramSpec = {
    type,
    ...(s(r.title, 80) ? { title: s(r.title, 80) } : {}),
    ...(s(r.caption, 160) ? { caption: s(r.caption, 160) } : {}),
    direction: /^(TB|TD|BT|DOWN|VERTICAL)$/.test(dir) ? "TB" : "LR",
    flow: flow === "down" || dir === "TB" || dir === "TD" ? "down" : "up",
    nodes,
    edges,
    groups,
    stages,
    layers,
    towers,
    panels,
    events,
    ...(tree ? { tree } : {}),
    ...(s(r.center, 60) ? { center: s(r.center, 60) } : {}),
    legend,
    explicitEdges: Array.isArray(r.edges) && type !== "architecture" && type !== "encoder_decoder",
    ...(type === "grid" && Number(r.cols ?? r.columns) >= 1 ? { cols: Math.min(6, Math.round(Number(r.cols ?? r.columns))) } : {}),
  };
  if (type === "cycle" && listed.length > 8) problems.push("cycle 最多 8 個 nodes");
  return { spec, problems };
}

/** Writer help (zh-TW rules + examples), used in the slides playbook rules. */
export const DIAGRAM_SPEC_HELP = `\`\`\`diagram（JSON）由系統排版成學術風格的 SVG 圖（文字一定放得下框）；流程圖、架構圖、比較圖都用它，不要用 Mermaid。
共通：節點 {"id":"enc","label":"短標籤 ≤ 4 個英文字","sub":"一行補充（可選）","kind":"input|process|model|data|output|highlight","icon":"waveform|spectrogram|transformer|attention|embedding|tokens|text|database|probe|chart|layers|mic|loss|align|cluster|subspace|speaker","frozen":true,"trainable":true,"repeat":12}；
論文的新貢獻用 "kind":"highlight"（強調色）；數學用 $...$（例如 "$h^{(\\ell)}_t$"）；連線 {"from":"a","to":"b","label":"短","kind":"flow|skip|residual|feedback|cross","style":"dashed"}；群組 "groups":[{"label":"Frozen SSL model","nodes":["a","b"],"style":"frozen|highlight"}]。
- pipeline（左→右流程；stages 每格一個節點，或 [a,b] 表示並列）：{"type":"pipeline","stages":[{"id":"wav","label":"Raw audio","kind":"input","icon":"waveform"},{"id":"ssl","label":"SSL encoder","sub":"12 layers","kind":"model","icon":"transformer","frozen":true},{"id":"probe","label":"Linear probe","kind":"highlight","icon":"probe"}],"edges":[{"from":"wav","to":"ssl"},{"from":"ssl","to":"probe","label":"$h^{(\\ell)}$"}]}
- architecture（由下往上的模型堆疊；row = 並排；repeat = × N 的區塊；不在 layers 裡的 nodes 放右側並用 edges 連）：{"type":"architecture","layers":[{"id":"x","label":"Log-Mel input","kind":"input","icon":"spectrogram"},{"repeat":12,"label":"Transformer block","layers":[{"id":"att","label":"Self-attention"},{"id":"ffn","label":"Feed-forward"}]},{"id":"out","label":"Representations","kind":"output","icon":"embedding"}],"nodes":[{"id":"probe","label":"Layer-wise probe","kind":"highlight"}],"edges":[{"from":"att","to":"probe","label":"each layer"},{"from":"x","to":"ffn","kind":"residual"}]}
- encoder_decoder：{"type":"encoder_decoder","encoder":{"title":"Encoder","layers":[…]},"decoder":{"title":"Decoder","layers":[…]},"edges":[{"from":"enc_out","to":"xattn","kind":"cross","label":"cross-attn"}]}
- comparison（並排比較做法）：{"type":"comparison","panels":[{"title":"Baseline","stages":["Audio","ASR","Text"]},{"title":"Ours","highlight":true,"stages":["Audio","Aligner","Words"]}]}（加 "direction":"LR" 改成上下兩列、每列左→右）
- cycle（循環）：{"type":"cycle","nodes":["Pseudo-label","Train","Evaluate"],"center":"Self-training"}；timeline：{"type":"timeline","events":[{"date":"2019","label":"wav2vec"}]}；tree：{"type":"tree","root":{"label":"Probing","children":[{"label":"Phonetic"},{"label":"Lexical"}]}}；graph（其他）：{"type":"graph","direction":"LR","nodes":[…],"edges":[…],"groups":[…]}
- grid（並列的項目，沒有先後順序：應用、資料集、比較的系統、任務、模型家族）：{"type":"grid","nodes":[{"label":"Dataset A","sub":"一行說明"},{"label":"Dataset B"},{"label":"Dataset C"}],"cols":3}（可用 groups 分組）。箭頭只表示資料流或步驟的先後；並列項目不要用 pipeline 串箭頭
規則：≤ 10 個節點；標籤短（細節放 sub 或講稿）；一張圖只表達一個想法；不要寫 title（投影片標題已經說了）。`;
