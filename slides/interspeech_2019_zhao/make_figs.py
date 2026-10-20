"""Generate chart/diagram snippets for the Zhao et al. 2019 deck.

All numbers are copied from the paper (zhao19_interspeech.pdf, Tables 2-6).
Run:  python3 make_figs.py   ->  writes _figs/*.md, included by index.qmd
"""
from pathlib import Path

OUT = Path(__file__).parent / "_figs"
OUT.mkdir(exist_ok=True)

SETS = ["Songs", "Cnt-Real", "Cnt-TTS", "Apps"]

# Table 2: shallow-fusion ablation (WER %)
T2 = {
    "E0": ("Grapheme, no biasing", [19.6, 18.6, 28.3, 13.0]),
    "E1": ("WPM, no biasing", [22.7, 15.8, 37.0, 13.3]),
    "E2": ("Grapheme, biasing", [14.8, 12.5, 24.2, 8.7]),
    "E3": ("+ subtractive cost", [8.1, 10.0, 13.2, 5.8]),
    "E4": ("+ WPM", [6.2, 8.3, 10.0, 3.6]),
    "E5": ("+ early biasing", [5.3, 7.5, 7.3, 2.7]),
}

# Table 3: anti-context (VS + biasing sets)
T3 = {
    "E1": ("No biasing", 6.9, [22.7, 15.8, 37.0, 13.3]),
    "E5": ("Biasing, no prefix", 12.5, [5.3, 7.5, 7.3, 2.7]),
    "E6": ("Non-empty prefix only", 7.0, [10.1, 6.9, 7.6, 2.7]),
    "E7": ("+ empty prefix", 12.5, [5.3, 7.9, 7.4, 2.4]),
    "E8": ("+ empty prefix, lower λ", 7.3, [5.3, 6.7, 6.8, 2.4]),
}

# Table 6: E2E vs conventional (130 MB CTC + PM + LM)
T6_SETS = ["VS", "Songs", "Cnt-Real", "Cnt-TTS", "Apps"]
T6_RNNT = [6.7, 3.0, 5.8, 5.4, 1.9]
T6_CONV = [9.3, 2.4, 6.8, 5.7, 2.4]


def fmt(v):
    return f"{v:.1f}"


def write(name, html):
    (OUT / f"{name}.md").write_text("```{=html}\n" + html.strip() + "\n```\n")


# ---------------------------------------------------------------- main result
def main_results():
    scale = 10.0
    rows = []
    for s, r, c in zip(T6_SETS, T6_RNNT, T6_CONV):
        rel = (r - c) / c * 100
        cls = "worse" if rel > 0 else ""
        note = "<small>anti-context</small>" if s == "VS" else ""
        rows.append(f"""
  <div class="bars-row"><span>{s}{note}</span>
    <div class="bar-pair">
      <div class="bar" data-tip="RNN-T + biasing · {s} · {fmt(r)}% WER"><i class="k-prop" style="width:{r/scale*100:.1f}%"></i><em style="left:calc({r/scale*100:.1f}% + 6px)">{fmt(r)}</em></div>
      <div class="bar" data-tip="Conventional · {s} · {fmt(c)}% WER"><i class="k-base" style="width:{c/scale*100:.1f}%"></i><em style="left:calc({c/scale*100:.1f}% + 6px)">{fmt(c)}</em></div>
    </div>
    <strong class="{cls}">{rel:+.0f}%</strong></div>""")
    html = f"""
<div class="bars" role="img" aria-label="WER of RNN-T with biasing versus conventional model on five test sets">
  <div class="bars-head"><span>Test set</span>
    <span class="keys"><span><i class="k-prop"></i>RNN-T + biasing (E9)</span><span><i class="k-base"></i>Conventional, 130 MB</span></span>
    <span>rel. WER vs conv.</span></div>
  {''.join(rows)}
</div>"""
    write("main_results", html)


# ---------------------------------------------------------------- ablation
def ablation():
    lo, hi = 0.0, 40.0
    x = lambda v: (v - lo) / (hi - lo) * 100
    steps = ["E1", "E2", "E3", "E4", "E5"]
    cls = {"E1": "e1", "E2": "s2", "E3": "s3", "E4": "s4", "E5": "s5"}
    rows = []
    for i, s in enumerate(SETS):
        vals = {e: T2[e][1][i] for e in steps}
        dots = "".join(
            f'<i class="dot {cls[e]}" style="left:{x(vals[e]):.2f}%" data-tip="{e} {T2[e][0]} · {fmt(vals[e])}%"></i>'
            for e in steps)
        a, b = min(vals.values()), max(vals.values())
        rows.append(f"""
  <div class="strip-row"><span>{s}</span><div class="strip-track">
    <i class="rail" style="left:{x(a):.2f}%;width:{x(b)-x(a):.2f}%"></i>{dots}
    <span class="val lo" style="left:{x(vals['E5']):.2f}%">{fmt(vals['E5'])}</span>
    <span class="val hi" style="left:{x(vals['E1']):.2f}%">{fmt(vals['E1'])}</span>
  </div></div>""")
    ticks = "".join(f'<span style="left:{x(t):.2f}%">{t:g}</span>' for t in (0, 10, 20, 30, 40))
    key_style = {"E1": 'class="e1"', "E2": 'style="background:var(--seq-1)"',
                 "E3": 'style="background:var(--seq-2)"', "E4": 'style="background:var(--seq-3)"',
                 "E5": 'style="background:var(--seq-4)"'}
    keys = "".join(f'<span><i {key_style[e]}></i>{e} {T2[e][0]}</span>' for e in steps)
    html = f"""
<div class="strip" role="img" aria-label="WER drops step by step from E1 to E5 on four biasing sets">
  {''.join(rows)}
  <div class="strip-axis">{ticks}</div>
  <div class="strip-keys">{keys}<span>WER %, lower is better</span></div>
</div>"""
    write("ablation", html)


# ---------------------------------------------------------------- anti-context
def anti_context():
    vs_scale = cr_scale = 24.0  # one shared WER axis so VS and Cnt-Real bars compare honestly
    rows = []
    for e, (name, vs, b) in T3.items():
        cr = b[1]
        vs_cls = "vs" if vs >= 10 else "vs ok"
        rows.append(f"""
  <div class="ac-row"><span>{e}<small>{name}</small></span>
    <div class="bar-pair">
      <div class="bar" data-tip="{e} · VS {fmt(vs)}%"><i class="{vs_cls}" style="width:{vs/vs_scale*100:.1f}%"></i><em style="left:calc({vs/vs_scale*100:.1f}% + 6px)">VS {fmt(vs)}</em></div>
      <div class="bar" data-tip="{e} · Cnt-Real {fmt(cr)}%"><i class="ref" style="width:{cr/cr_scale*100:.1f}%"></i><em style="left:calc({cr/cr_scale*100:.1f}% + 6px)">Cnt-Real {fmt(cr)}</em></div>
    </div></div>""")
    html = f"""
<div class="ac" role="img" aria-label="VS WER rises to 12.5 without prefixes and returns to 7.3 with empty-prefix lower weight">
  {''.join(rows)}
</div>"""
    write("anti_context", html)


# ---------------------------------------------------------------- architecture
def arch(mode):
    """mode: arch | train | infer — same nodes, same names on all three pages."""
    train = mode == "train"
    fuse_cls = "ghost" if train else "new"
    fst_cls = "ghost" if train else "new"
    beam_cls = "ghost" if train else ""
    out = ('<div class="node out"><span class="tag">Loss</span><b>RNN-T loss</b><small>all weights updated</small></div>'
           if train else
           '<div class="node out"><span class="tag">Output</span><b>y*</b><small>best wordpiece sequence</small></div>')
    fuse_txt = ("not used in training" if train else "log P(y|x) + λ log P<sub>C</sub>(y)<br>applied before pruning")
    fst_txt = ("compiled at test time,<br>no parameters" if train else
               "prefix FST · min(det(S∘G))<br>wordpiece arcs, per utterance")
    beam_txt = "not used in training" if train else "keep top k ≈ 4–10"
    up_new = "" if train else " new"
    html = f"""
<div class="flow flow-11" role="img" aria-label="RNN-T with contextual FST shallow fusion, {mode} view">
  <div class="node"><span class="tag">Input</span><b>80-d log-Mel</b><small>stack 4 frames<br>30 ms rate</small></div>
  <div class="arrow"><span>x</span><i></i></div>
  <div class="node"><span class="tag">Encoder</span><b>8 × LSTM</b><small>2,000 units, 600 proj<br>+ time reduction</small></div>
  <div class="arrow"><span>h<sub>t</sub></span><i></i></div>
  <div class="node"><span class="tag">Joint</span><b>Joint + softmax</b><small>600 units<br>4,096 wordpieces</small></div>
  <div class="arrow"><span>P(y|x)</span><i></i></div>
  <div class="node {fuse_cls}"><span class="tag">Fusion</span><b>Biased score</b><small>{fuse_txt}</small></div>
  <div class="arrow"><span>{'' if train else 'scores'}</span><i></i></div>
  <div class="node {beam_cls}"><span class="tag">Search</span><b>Beam pruning</b><small>{beam_txt}</small></div>
  <div class="arrow"><span></span><i></i></div>
  {out}
</div>
<div class="flow flow-11 links">
  <div></div><div></div><div></div><div></div>
  <div class="up"><i></i><span>g<sub>u</sub></span></div><div></div>
  <div class="up{up_new}"><i></i><span>{'' if train else 'P<sub>C</sub>(y)'}</span></div>
  <div></div><div></div><div></div><div></div>
</div>
<div class="flow flow-11">
  <div></div><div></div><div></div><div></div>
  <div class="node"><span class="tag">Decoder</span><b>2 × LSTM</b><small>2,000 units, 600 proj<br>prev. wordpieces</small></div>
  <div></div>
  <div class="node {fst_cls}"><span class="tag">Context</span><b>Contextual FST</b><small>{fst_txt}</small></div>
  <div></div><div></div><div></div><div></div>
</div>"""
    write(f"arch_{mode}", html)


# ---------------------------------------------------------------- Fig. 1 FST
def fst_fig():
    # Redrawn from paper Fig. 1: contextual FST for "cat", subword arcs w/ backoff.
    xs = [70, 270, 470, 670, 900]
    nodes = "".join(
        f'<circle cx="{x}" cy="70" r="24" fill="#fff" stroke="#202328" stroke-width="1.2"/>'
        f'<text x="{x}" y="76" text-anchor="middle" font-size="17">{i}</text>' for i, x in enumerate(xs))
    nodes += f'<circle cx="{xs[4]}" cy="70" r="19" fill="none" stroke="#202328" stroke-width="1.2"/>'
    fwd_lbl = ["c:c / −0.25", "a:a / −0.25", "t:t / −0.25", "␣:␣ / −0.25"]
    fwd = "".join(
        f'<line x1="{xs[i]+24}" y1="70" x2="{xs[i+1]-28}" y2="70" stroke="#b85f2d" stroke-width="1.6" marker-end="url(#ah-o)"/>'
        f'<text x="{(xs[i]+xs[i+1])/2}" y="58" text-anchor="middle" font-size="15" fill="#b85f2d">{fwd_lbl[i]}</text>'
        for i in range(4))
    back_lbl = ["ε:ε / +0.25", "ε:ε / +0.5", "ε:ε / +0.75"]
    back = ""
    for k, i in enumerate((1, 2, 3)):
        d = 34 + 30 * k
        back += (f'<path d="M {xs[i]} 94 C {xs[i]} {110+d}, {xs[0]} {110+d}, {xs[0]} 98" fill="none" '
                 f'stroke="#81878c" stroke-width="1" stroke-dasharray="4 3" marker-end="url(#ah-g)"/>'
                 f'<text x="{(xs[i]+xs[0])/2 + 40}" y="{96+d*0.78}" text-anchor="middle" font-size="14" fill="#686f77">{back_lbl[k]}</text>')
    html = f"""
<figure class="fst-figure">
<svg viewBox="0 0 980 210" role="img" aria-label="Contextual FST for the word cat: each matched subword adds minus 0.25, failure arcs give the bonus back">
  <defs>
    <marker id="ah-o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#b85f2d"/></marker>
    <marker id="ah-g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#81878c"/></marker>
  </defs>
  <g font-family="Source Sans 3, sans-serif" fill="#202328">{fwd}{back}{nodes}</g>
</svg>
<figcaption>Redrawn from paper Fig. 1 (cost = −log weight; negative = bonus). Orange: match arc, bonus per subword. Dashed: failure arc that subtracts the bonus already given.</figcaption>
</figure>"""
    write("fst_fig", html)


if __name__ == "__main__":
    main_results()
    ablation()
    anti_context()
    for m in ("arch", "train", "infer"):
        arch(m)
    fst_fig()
    print("wrote", sorted(p.name for p in OUT.iterdir()))
