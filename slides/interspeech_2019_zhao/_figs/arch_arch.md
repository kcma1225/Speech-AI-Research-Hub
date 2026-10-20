```{=html}
<div class="flow flow-11" role="img" aria-label="RNN-T with contextual FST shallow fusion, arch view">
  <div class="node"><span class="tag">Input</span><b>80-d log-Mel</b><small>stack 4 frames<br>30 ms rate</small></div>
  <div class="arrow"><span>x</span><i></i></div>
  <div class="node"><span class="tag">Encoder</span><b>8 × LSTM</b><small>2,000 units, 600 proj<br>+ time reduction</small></div>
  <div class="arrow"><span>h<sub>t</sub></span><i></i></div>
  <div class="node"><span class="tag">Joint</span><b>Joint + softmax</b><small>600 units<br>4,096 wordpieces</small></div>
  <div class="arrow"><span>P(y|x)</span><i></i></div>
  <div class="node new"><span class="tag">Fusion</span><b>Biased score</b><small>log P(y|x) + λ log P<sub>C</sub>(y)<br>applied before pruning</small></div>
  <div class="arrow"><span>scores</span><i></i></div>
  <div class="node "><span class="tag">Search</span><b>Beam pruning</b><small>keep top k ≈ 4–10</small></div>
  <div class="arrow"><span></span><i></i></div>
  <div class="node out"><span class="tag">Output</span><b>y*</b><small>best wordpiece sequence</small></div>
</div>
<div class="flow flow-11 links">
  <div></div><div></div><div></div><div></div>
  <div class="up"><i></i><span>g<sub>u</sub></span></div><div></div>
  <div class="up new"><i></i><span>P<sub>C</sub>(y)</span></div>
  <div></div><div></div><div></div><div></div>
</div>
<div class="flow flow-11">
  <div></div><div></div><div></div><div></div>
  <div class="node"><span class="tag">Decoder</span><b>2 × LSTM</b><small>2,000 units, 600 proj<br>prev. wordpieces</small></div>
  <div></div>
  <div class="node new"><span class="tag">Context</span><b>Contextual FST</b><small>prefix FST · min(det(S∘G))<br>wordpiece arcs, per utterance</small></div>
  <div></div><div></div><div></div><div></div>
</div>
```
