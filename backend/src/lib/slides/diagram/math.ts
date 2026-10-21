/**
 * A small TeX subset for diagram labels (`$…$`), laid out with the KaTeX fonts: letters in Math-Italic, digits /
 * operators / upright Greek in Main, `\mathbf` in Main-Bold, `\boldsymbol` in Math-BoldItalic, `\text{}` in the label
 * face. Supports sub/superscripts, `\frac`, `\sqrt`, accents (`\hat \bar \tilde \vec \dot`), `\left( \right)` (plain
 * delimiters), spacing commands and the common symbols of speech/ML papers. Unknown commands render their name
 * upright (never raw `\cmd` noise). Output: boxes positioned relative to the baseline (y down = positive depth).
 */
import { faceFor, hasGlyph, shapeRun, type FaceId, type GlyphRun, type TextStyle } from "./fonts.js";

export type MathItem = { kind: "run"; run: GlyphRun } | { kind: "rule"; x: number; y: number; w: number; h: number };
/** width; height above the baseline; depth below it; items with dx/dy relative to (box start, baseline). */
export type MathBox = { width: number; height: number; depth: number; items: MathItem[] };

const SYM: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  times: "×", cdot: "⋅", pm: "±", mp: "∓", div: "÷", ast: "∗", star: "⋆", circ: "∘", bullet: "∙", oplus: "⊕", otimes: "⊗", odot: "⊙",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃", equiv: "≡", propto: "∝", ll: "≪", gg: "≫",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", supset: "⊃", cup: "∪", cap: "∩", perp: "⊥", parallel: "∥", mid: "∣",
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", mapsto: "↦", uparrow: "↑", downarrow: "↓",
  sum: "∑", prod: "∏", int: "∫", partial: "∂", nabla: "∇", infty: "∞", forall: "∀", exists: "∃", emptyset: "∅", ell: "ℓ", hbar: "ℏ",
  langle: "⟨", rangle: "⟩", lVert: "∥", rVert: "∥", Vert: "∥", vert: "|", lvert: "|", rvert: "|", lbrace: "{", rbrace: "}", ldots: "…", cdots: "⋯", dots: "…", prime: "′",
  top: "⊤", intercal: "⊺", dagger: "†", angle: "∠", triangle: "△", square: "□", checkmark: "✓",
};
const OPERATORS = new Set(["log", "exp", "max", "min", "arg", "argmax", "argmin", "softmax", "sin", "cos", "tan", "tanh", "lim", "sup", "inf", "det", "dim", "Pr", "mod", "diag", "Tr", "tr", "sign", "KL", "rank", "cat", "concat", "ReLU", "GELU", "LayerNorm", "Attn", "Attention", "MLP", "FFN", "CTC", "ln", "lg"]);
const REL = new Set(["=", "<", ">", "≤", "≥", "≠", "≈", "∼", "≃", "≡", "∝", "≪", "≫", "∈", "∉", "⊂", "⊆", "⊃", "→", "←", "↔", "⇒", "⇐", "↦", "⊥", "∥", ":"]);
const BIN = new Set(["+", "-", "−", "×", "⋅", "±", "∓", "÷", "∗", "⋆", "∘", "∙", "⊕", "⊗", "⊙", "∪", "∩"]);
const PUNCT = new Set([",", ";"]);
const SPACES: Record<string, number> = { ",": 0.17, ":": 0.22, ";": 0.28, "!": -0.17, quad: 1, qquad: 2, " ": 0.25, enspace: 0.5, thinspace: 0.17 };
const ACCENTS: Record<string, string> = { hat: "ˆ", widehat: "ˆ", tilde: "˜", widetilde: "˜", bar: "¯", overline: "¯", vec: "→", dot: "˙", ddot: "¨" };

type Tok = { t: "cmd" | "char" | "open" | "close" | "sup" | "sub"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      if (m) {
        out.push({ t: "cmd", v: m[1]! });
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "{") out.push({ t: "open", v: c });
    else if (c === "}") out.push({ t: "close", v: c });
    else if (c === "^") out.push({ t: "sup", v: c });
    else if (c === "_") out.push({ t: "sub", v: c });
    else if (/\s/.test(c)) continue;
    else out.push({ t: "char", v: c });
  }
  return out;
}

type Font = "it" | "rm" | "bf" | "bi" | "text";
type Node =
  | { k: "sym"; ch: string; font: Font; cls: "ord" | "bin" | "rel" | "op" | "punct" | "open" | "close" }
  | { k: "text"; s: string; font: Font }
  | { k: "list"; items: Node[] }
  | { k: "scripts"; base: Node; sup?: Node; sub?: Node }
  | { k: "frac"; num: Node; den: Node }
  | { k: "sqrt"; body: Node }
  | { k: "accent"; acc: string; body: Node }
  | { k: "space"; em: number };

class Parser {
  i = 0;
  constructor(public toks: Tok[]) {}
  parseList(font: Font, stop?: (t: Tok) => boolean): Node {
    const items: Node[] = [];
    while (this.i < this.toks.length) {
      const t = this.toks[this.i]!;
      if (t.t === "close" || (stop && stop(t))) break;
      if (t.t === "sup" || t.t === "sub") {
        this.i++;
        const arg = this.parseArg(font);
        const prev = items.pop() ?? { k: "list", items: [] };
        const base = prev.k === "scripts" ? prev : { k: "scripts" as const, base: prev };
        if (t.t === "sup") base.sup = arg;
        else base.sub = arg;
        items.push(base);
        continue;
      }
      const n = this.parseAtom(font);
      if (n) items.push(n);
    }
    return { k: "list", items };
  }
  /** One argument: a group `{…}` or a single atom. */
  parseArg(font: Font): Node {
    const t = this.toks[this.i];
    if (!t) return { k: "list", items: [] };
    if (t.t === "open") {
      this.i++;
      const n = this.parseList(font);
      if (this.toks[this.i]?.t === "close") this.i++;
      return n;
    }
    return this.parseAtom(font) ?? { k: "list", items: [] };
  }
  rawGroup(): string {
    const t = this.toks[this.i];
    if (t?.t !== "open") return "";
    let depth = 0;
    let s = "";
    for (; this.i < this.toks.length; this.i++) {
      const x = this.toks[this.i]!;
      if (x.t === "open") {
        if (depth++ > 0) s += "{";
      } else if (x.t === "close") {
        if (--depth === 0) {
          this.i++;
          break;
        }
        s += "}";
      } else s += x.t === "cmd" ? (x.v === " " ? " " : SYM[x.v] ?? x.v) : x.t === "sup" ? "^" : x.t === "sub" ? "_" : x.v;
    }
    return s;
  }
  parseAtom(font: Font): Node | null {
    const t = this.toks[this.i++]!;
    if (t.t === "open") {
      const n = this.parseList(font);
      if (this.toks[this.i]?.t === "close") this.i++;
      return n;
    }
    if (t.t === "char") return sym(t.v, font);
    if (t.t !== "cmd") return null;
    const c = t.v;
    if (c in SPACES) return { k: "space", em: SPACES[c]! };
    if (c === "frac" || c === "dfrac" || c === "tfrac") return { k: "frac", num: this.parseArg(font), den: this.parseArg(font) };
    if (c === "sqrt") return { k: "sqrt", body: this.parseArg(font) };
    if (c in ACCENTS) return { k: "accent", acc: c, body: this.parseArg(font) };
    if (c === "mathbf" || c === "bf") return this.parseArg("bf");
    if (c === "boldsymbol" || c === "bm") return this.parseArg("bi");
    if (c === "mathrm" || c === "rm" || c === "mathsf" || c === "mathtt" || c === "operatorname") return this.parseArg("rm");
    if (c === "mathit" || c === "mathcal" || c === "mathbb" || c === "mathscr") return this.parseArg(c === "mathit" ? "it" : "rm");
    if (c === "text" || c === "textrm" || c === "textbf" || c === "textit" || c === "mbox") return { k: "text", s: this.rawGroup(), font: "text" };
    if (c === "left" || c === "right" || c === "big" || c === "Big" || c === "bigl" || c === "bigr" || c === "Bigl" || c === "Bigr") return null;
    if (c === "limits" || c === "nolimits" || c === "displaystyle" || c === "textstyle") return null;
    if (OPERATORS.has(c)) return { k: "text", s: c, font: "rm" };
    if (SYM[c]) return sym(SYM[c]!, /^[A-Z]/.test(c) && c.length > 1 && /[Α-Ω]/.test(SYM[c]!) ? "rm" : font);
    if (c === "{" || c === "}" || c === "%" || c === "$" || c === "#" || c === "&" || c === "_") return sym(c, "rm");
    return { k: "text", s: c, font: "rm" };
  }
}

function sym(ch: string, font: Font): Node {
  const cls = REL.has(ch) ? "rel" : BIN.has(ch) ? "bin" : PUNCT.has(ch) ? "punct" : /[([⟨{]/.test(ch) ? "open" : /[)\]⟩}]/.test(ch) ? "close" : /[∑∏∫]/.test(ch) ? "op" : "ord";
  return { k: "sym", ch: ch === "-" ? "−" : ch, font, cls };
}

/** Face for one math character in a math font style. */
function mathFace(ch: string, font: Font, text: TextStyle): FaceId | null {
  if (font === "text") return faceFor(ch, text);
  const latinLetter = /^[A-Za-z]$/.test(ch);
  const lowerGreek = /^[α-ωϵϑϕϖϱς]$/.test(ch);
  if (font === "bf") return latinLetter || /\d/.test(ch) ? "main-bold" : lowerGreek ? "math-bolditalic" : "main-bold";
  if (font === "bi") return latinLetter || lowerGreek ? "math-bolditalic" : "main-bold";
  if (font === "it" && (latinLetter || lowerGreek || ch === "∂")) return "math-italic";
  for (const id of ["main", "ams"] as const) if (hasGlyph(id, ch)) return id;
  return faceFor(ch, text) ?? "main";
}

const SPACE_AROUND = { rel: 0.28, bin: 0.22, punct: 0 } as const;

function layout(n: Node, size: number, text: TextStyle, script = 0): MathBox {
  switch (n.k) {
    case "space":
      return { width: n.em * size, height: 0, depth: 0, items: [] };
    case "sym": {
      const run = shapeRun(mathFace(n.ch, n.font, text), n.ch, n.cls === "op" ? size * 1.15 : size);
      const box = runBox(run, size);
      // Binary / relation spacing (not inside scripts, like TeX).
      if (script === 0 && (n.cls === "rel" || n.cls === "bin")) {
        const sp = SPACE_AROUND[n.cls] * size;
        run.dx += sp;
        box.width += sp * 2;
      } else if (n.cls === "punct") box.width += 0.17 * size;
      return box;
    }
    case "text": {
      const run = n.font === "text" ? null : shapeRun("main", n.s, size);
      if (run) return runBox(run, size);
      // \text{}: the label face (may mix Latin / CJK).
      const items: MathItem[] = [];
      let x = 0;
      for (const ch of n.s) {
        const r = shapeRun(faceFor(ch, text), ch, size);
        r.dx = x;
        x += r.width;
        items.push({ kind: "run", run: r });
      }
      return { width: x, height: size * 0.75, depth: size * 0.2, items };
    }
    case "list":
      return hlist(n.items.map((it) => layout(it, size, text, script)));
    case "scripts": {
      const base = layout(n.base, size, text, script);
      const ss = size * (script ? 0.82 : 0.72);
      const sup = n.sup ? layout(n.sup, ss, text, script + 1) : null;
      const sub = n.sub ? layout(n.sub, ss, text, script + 1) : null;
      const items = [...base.items];
      let height = base.height;
      let depth = base.depth;
      const supShift = Math.max(size * 0.42, base.height - ss * 0.35);
      const subShift = Math.max(size * (sup ? 0.26 : 0.18), sub ? sub.height - size * 0.45 : 0);
      const x0 = base.width + (n.base.k === "sym" && n.base.font === "it" ? size * 0.04 : 0);
      if (sup) {
        items.push(...shift(sup.items, x0, -supShift));
        height = Math.max(height, supShift + sup.height);
      }
      if (sub) {
        items.push(...shift(sub.items, base.width, subShift));
        depth = Math.max(depth, subShift + sub.depth);
      }
      return { width: Math.max(x0 + (sup?.width ?? 0), base.width + (sub?.width ?? 0)) + size * 0.05, height, depth, items };
    }
    case "frac": {
      const fs = size * (script ? 0.85 : 0.8);
      const num = layout(n.num, fs, text, script + 1);
      const den = layout(n.den, fs, text, script + 1);
      const w = Math.max(num.width, den.width) + size * 0.24;
      const axis = size * 0.27;
      const rule = Math.max(1, size * 0.05);
      const gap = size * 0.12;
      const items: MathItem[] = [
        ...shift(num.items, (w - num.width) / 2, -(axis + rule / 2 + gap + num.depth)),
        ...shift(den.items, (w - den.width) / 2, -axis + rule / 2 + gap + den.height),
        { kind: "rule", x: size * 0.06, y: -axis - rule / 2, w: w - size * 0.12, h: rule },
      ];
      return { width: w + size * 0.1, height: axis + rule / 2 + gap + num.depth + num.height, depth: -axis + rule / 2 + gap + den.height + den.depth, items };
    }
    case "sqrt": {
      const body = layout(n.body, size, text, script);
      const sign = shapeRun("main", "√", size * 1.05);
      const sb = runBox(sign, size);
      const top = Math.max(body.height + size * 0.12, size * 0.8);
      const rule = Math.max(1, size * 0.05);
      return {
        width: sb.width + body.width + size * 0.08,
        height: top + rule,
        depth: Math.max(body.depth, sb.depth),
        items: [...sb.items, ...shift(body.items, sb.width, 0), { kind: "rule", x: sb.width - size * 0.02, y: -top - rule, w: body.width + size * 0.1, h: rule }],
      };
    }
    case "accent": {
      const body = layout(n.body, size, text, script);
      if (n.acc === "bar" || n.acc === "overline") {
        const rule = Math.max(1, size * 0.05);
        const y = -(body.height + size * 0.08);
        return { width: body.width, height: body.height + size * 0.12, depth: body.depth, items: [...body.items, { kind: "rule", x: size * 0.05, y: y - rule, w: Math.max(size * 0.3, body.width - size * 0.05), h: rule }] };
      }
      const accRun = shapeRun("main", ACCENTS[n.acc]!, n.acc === "vec" ? size * 0.7 : size);
      const ab = runBox(accRun, size);
      const lift = body.height - size * (n.acc === "vec" ? 0.38 : 0.62) + (n.acc === "vec" ? 0 : size * 0.05);
      const dx = (body.width - ab.width) / 2 + (n.body.k === "sym" && n.body.font === "it" ? size * 0.08 : 0);
      return { width: body.width, height: Math.max(body.height, lift + size * (n.acc === "vec" ? 0.55 : 0.75)), depth: body.depth, items: [...body.items, ...shift(ab.items, dx, -lift)] };
    }
  }
}

function runBox(run: GlyphRun, size: number): MathBox {
  const tall = /[∑∏∫(){}[\]⟨⟩|∥√]/.test(run.text);
  const desc = /[gjpqyβγζημξρφχψ∫(){}[\]⟨⟩|,;]/.test(run.text);
  return { width: run.width, height: size * (tall ? 0.8 : /[A-Zbdfhklt0-9∂δθλ]/.test(run.text) ? 0.72 : 0.5), depth: size * (tall || desc ? 0.22 : 0.02), items: [{ kind: "run", run }] };
}

function shift(items: MathItem[], dx: number, dy: number): MathItem[] {
  return items.map((it) => (it.kind === "run" ? { kind: "run", run: { ...it.run, dx: it.run.dx + dx, dy: it.run.dy + dy } } : { ...it, x: it.x + dx, y: it.y + dy }));
}

function hlist(boxes: MathBox[]): MathBox {
  let x = 0;
  const items: MathItem[] = [];
  let height = 0;
  let depth = 0;
  for (const b of boxes) {
    items.push(...shift(b.items, x, 0));
    x += b.width;
    height = Math.max(height, b.height);
    depth = Math.max(depth, b.depth);
  }
  return { width: x, height, depth, items };
}

/** Lays out a TeX string at `size`; `text` = the surrounding label style (for `\text{}`). */
export function layoutMath(tex: string, size: number, text: TextStyle): MathBox {
  const p = new Parser(tokenize(tex.slice(0, 400)));
  const nodes: Node[] = [];
  // Unbalanced closing braces: skip them instead of stopping.
  while (p.i < p.toks.length) {
    nodes.push(p.parseList("it"));
    p.i++;
  }
  return hlist(nodes.map((n) => layout(n, size, text)));
}
