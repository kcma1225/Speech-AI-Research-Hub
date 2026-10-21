/**
 * Mermaid flowchart → ```diagram spec, so generated decks get the academic SVG even when a writer still produced
 * Mermaid. Supports the flowchart subset models write (node shapes, chained / labelled / dotted / thick edges, `&`,
 * subgraphs, `style` for the new module or frozen parts). Anything else (sequence diagrams, click, …) → null and
 * the Mermaid cell stays as it is.
 */
type Node = { id: string; label: string; shape: string; kind?: string; icon?: string; frozen?: boolean };
type Edge = { from: string; to: string; label?: string; style?: string; both?: boolean };

const SHAPES: [RegExp, string][] = [
  [/^\(\[(.*)\]\)$/, "pill"],
  [/^\[\((.*)\)\]$/, "cylinder"],
  [/^\(\((.*)\)\)$/, "circle"],
  [/^\[\[(.*)\]\]$/, "box"],
  [/^\{\{(.*)\}\}$/, "box"],
  [/^\[\/(.*)\/\]$/, "box"],
  [/^\[(.*)\]$/, "box"],
  [/^\((.*)\)$/, "pill"],
  [/^\{(.*)\}$/, "box"],
  [/^>(.*)\]$/, "box"],
];

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/s, "$1").replace(/<br\s*\/?>/gi, "\n").replace(/&quot;/g, '"').replace(/#quot;/g, '"').trim();

function parseNodeToken(tok: string, nodes: Map<string, Node>): string | null {
  const m = /^([A-Za-z_一-鿿][\w一-鿿-]*)\s*(.*)$/s.exec(tok.trim());
  if (!m) return null;
  const id = m[1]!;
  const rest = m[2]!.trim().replace(/:::\w+$/, "");
  if (rest) {
    for (const [re, shape] of SHAPES) {
      const sm = re.exec(rest);
      if (sm) {
        const label = unquote(sm[1]!);
        const prev = nodes.get(id);
        nodes.set(id, { ...(prev ?? {}), id, label: label || id, shape });
        return id;
      }
    }
    return null;
  }
  if (!nodes.has(id)) nodes.set(id, { id, label: id, shape: "box" });
  return id;
}

const EDGE_SPLIT = /\s*(<?(?:-{2,3}>|-\.-?>|={2,3}>|-{3}|-\.-|={3})(?:\|[^|]*\|)?)\s*/;

const ICON_RULES: [RegExp, string][] = [
  [/spectrogram|mel\b|fbank|log-?mel|頻譜/i, "spectrogram"],
  [/audio|waveform|speech|wav\b|raw signal|utterance|語音|音訊|波形/i, "waveform"],
  [/attention|attn|注意力/i, "attention"],
  [/encoder|decoder|transformer|wav2vec|hubert|wavlm|whisper|conformer|bert|layer|編碼器|解碼器/i, "transformer"],
  [/embedding|representation|feature|hidden|vector|表徵|特徵|向量/i, "embedding"],
  [/token|transcript|text|word|文字|詞/i, "tokens"],
  [/dataset|corpus|database|資料集|語料/i, "database"],
  [/probe|classifier|探測|分類器/i, "probe"],
  [/accuracy|wer\b|score|metric|result|evaluation|準確|結果|評估/i, "chart"],
  [/loss|objective|損失/i, "loss"],
  [/align|timestamp|對齊|時間戳/i, "align"],
  [/cluster|k-?means|分群/i, "cluster"],
  [/subspace|projection|orthogonal|子空間|投影/i, "subspace"],
];

export function mermaidToSpec(code: string): Record<string, unknown> | null {
  const lines = code.split("\n").map((l) => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  const head = /^(flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/i.exec(lines[0] ?? "");
  if (!head) return null;
  const dir = head[2]!.toUpperCase();
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const groups: { label: string; nodes: string[]; style?: string }[] = [];
  const stack: { label: string; nodes: string[] }[] = [];
  const highlight = new Set<string>();
  const frozen = new Set<string>();
  for (const raw of lines.slice(1)) {
    let line = raw.replace(/;$/, "");
    if (/^(classDef|class|linkStyle|click|direction)\b/.test(line)) continue;
    const sg = /^subgraph\s+(?:([\w-]+)\s*\[(.+)\]|(.+))$/.exec(line);
    if (sg) {
      stack.push({ label: unquote(sg[2] ?? sg[3] ?? sg[1] ?? ""), nodes: [] });
      continue;
    }
    if (/^end$/.test(line)) {
      const g = stack.pop();
      if (g && g.nodes.length) groups.push(g);
      continue;
    }
    const st = /^style\s+([\w-]+)\s+(.+)$/.exec(line);
    if (st) {
      const css = st[2]!;
      const sw = /stroke-width\s*:\s*(\d+)/.exec(css);
      if (sw && Number(sw[1]) >= 3) highlight.add(st[1]!);
      if (/fill\s*:\s*#(ddd|ccc|eee|e5e7eb|d1d5db|bbb|aaa)\b|fill\s*:\s*(gray|grey|lightgray|lightgrey)/i.test(css)) frozen.add(st[1]!);
      if (/fill\s*:\s*#(f[a-f0-9]{2}[0-9a-f]{3}|ff[0-9a-f]{4}|fe[0-9a-f]{4})/i.test(css) && !sw) highlight.add(st[1]!);
      continue;
    }
    // Inline edge labels → pipe form.
    line = line
      .replace(/--\s+([^->|][^>|]*?)\s+-->/g, "-->|$1|")
      .replace(/-\.\s+([^.>|][^>|]*?)\s+\.->/g, "-.->|$1|")
      .replace(/==\s+([^=>|][^>|]*?)\s+==>/g, "==>|$1|");
    const parts = line.split(EDGE_SPLIT);
    if (parts.length === 1) {
      for (const t of line.split(/\s*&\s*/)) {
        const id = parseNodeToken(t, nodes);
        if (!id) return null;
        if (stack.length) stack.at(-1)!.nodes.push(id);
      }
      continue;
    }
    let prev: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const ids: string[] = [];
      for (const t of parts[i]!.split(/\s*&\s*/)) {
        if (!t.trim()) continue;
        const id = parseNodeToken(t, nodes);
        if (!id) return null;
        ids.push(id);
        if (stack.length) stack.at(-1)!.nodes.push(id);
      }
      if (i > 0) {
        const op = parts[i - 1]!;
        const lab = /\|([^|]*)\|/.exec(op)?.[1];
        const style = /-\./.test(op) ? "dashed" : undefined;
        for (const a of prev) for (const b of ids) edges.push({ from: a, to: b, ...(lab ? { label: unquote(lab) } : {}), ...(style ? { style } : {}), ...(op.startsWith("<") ? { both: true } : {}) });
      }
      prev = ids;
    }
  }
  if (!nodes.size || nodes.size > 18) return null;
  // Kinds: style marks, then sources / sinks, then keywords.
  const ins = new Map<string, number>();
  const outs = new Map<string, number>();
  for (const e of edges) {
    outs.set(e.from, (outs.get(e.from) ?? 0) + 1);
    ins.set(e.to, (ins.get(e.to) ?? 0) + 1);
  }
  const specNodes = [...nodes.values()].map((n) => {
    const icon = ICON_RULES.find(([re]) => re.test(n.label))?.[1];
    const kind = highlight.has(n.id) ? "highlight" : n.shape === "cylinder" ? "data" : !ins.get(n.id) && edges.length ? "input" : !outs.get(n.id) && edges.length ? "output" : /encoder|decoder|transformer|model|network|wav2vec|hubert|whisper|bert|模型|編碼|解碼/i.test(n.label) ? "model" : "process";
    return { id: n.id, label: n.label.slice(0, 64), kind, ...(icon ? { icon } : {}), ...(frozen.has(n.id) ? { frozen: true } : {}), ...(n.shape === "circle" ? { shape: "circle" } : {}) };
  });
  const groupSpecs = groups.map((g) => ({ label: g.label, nodes: [...new Set(g.nodes)], ...(g.nodes.every((id) => frozen.has(id)) ? { style: "frozen" } : g.nodes.some((id) => highlight.has(id)) ? { style: "highlight" } : {}) }));
  // A simple chain without groups → pipeline (in chain order).
  const order: string[] = [];
  const start = specNodes.find((n) => !ins.get(n.id));
  const simple = !groupSpecs.length && start && edges.length === nodes.size - 1 && [...nodes.keys()].every((id) => (ins.get(id) ?? 0) <= 1 && (outs.get(id) ?? 0) <= 1);
  if (simple) {
    let cur: string | undefined = start!.id;
    while (cur && !order.includes(cur)) {
      order.push(cur);
      cur = edges.find((e) => e.from === cur)?.to;
    }
  }
  const vertical = dir === "TD" || dir === "TB" || dir === "BT";
  if (simple && order.length === nodes.size) {
    const byId = new Map(specNodes.map((n) => [n.id, n]));
    return { type: "pipeline", direction: vertical ? "TB" : "LR", stages: order.map((id) => byId.get(id)), edges: edges.map((e) => ({ ...e })) };
  }
  return { type: "graph", direction: vertical ? "TB" : "LR", nodes: specNodes, edges, groups: groupSpecs };
}

/** ```{mermaid} cells of a body that convert → ```diagram fences (others unchanged). */
export function mermaidCellsToDiagrams(body: string): { body: string; converted: number } {
  let converted = 0;
  const out = body.replace(/^```\{mermaid\}[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (all, code: string) => {
    const spec = mermaidToSpec(code.replace(/^%%\{init[\s\S]*?\}%%\s*$/m, ""));
    if (!spec) return all;
    converted++;
    return `\`\`\`diagram\n${JSON.stringify(spec)}\n\`\`\``;
  });
  return { body: out, converted };
}
