/* Reveal.js 標註插件：雷射筆、畫筆、螢光筆、物件橡皮擦。 */
(function () {
  "use strict";
  const ICON = {"laser":["M232,120h-8.34A96.14,96.14,0,0,0,136,32.34V24a8,8,0,0,0-16,0v8.34A96.14,96.14,0,0,0,32.34,120H24a8,8,0,0,0,0,16h8.34A96.14,96.14,0,0,0,120,223.66V232a8,8,0,0,0,16,0v-8.34A96.14,96.14,0,0,0,223.66,136H232a8,8,0,0,0,0-16Zm-96,87.6V200a8,8,0,0,0-16,0v7.6A80.15,80.15,0,0,1,48.4,136H56a8,8,0,0,0,0-16H48.4A80.15,80.15,0,0,1,120,48.4V56a8,8,0,0,0,16,0V48.4A80.15,80.15,0,0,1,207.6,120H200a8,8,0,0,0,0,16h7.6A80.15,80.15,0,0,1,136,207.6ZM128,88a40,40,0,1,0,40,40A40,40,0,0,0,128,88Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,152Z"],"pen":["M248,92.68a15.86,15.86,0,0,0-4.69-11.31L174.63,12.68a16,16,0,0,0-22.63,0L123.57,41.11l-58,21.77A16.06,16.06,0,0,0,55.35,75.23L32.11,214.68A8,8,0,0,0,40,224a8.4,8.4,0,0,0,1.32-.11l139.44-23.24a16,16,0,0,0,12.35-10.17l21.77-58L243.31,104A15.87,15.87,0,0,0,248,92.68Zm-69.87,92.19L63.32,204l47.37-47.37a28,28,0,1,0-11.32-11.32L52,192.7,71.13,77.86,126,57.29,198.7,130ZM112,132a12,12,0,1,1,12,12A12,12,0,0,1,112,132Zm96-15.32L139.31,48l24-24L232,92.68Z"],"marker":["M253.66,106.34a8,8,0,0,0-11.32,0L192,156.69,107.31,72l50.35-50.34a8,8,0,1,0-11.32-11.32L96,60.69A16,16,0,0,0,93.18,79.5L72,100.69a16,16,0,0,0,0,22.62L76.69,128,18.34,186.34a8,8,0,0,0,3.13,13.25l72,24A7.88,7.88,0,0,0,96,224a8,8,0,0,0,5.66-2.34L136,187.31l4.69,4.69a16,16,0,0,0,22.62,0l21.19-21.18A16,16,0,0,0,203.31,168l50.35-50.34A8,8,0,0,0,253.66,106.34ZM93.84,206.85l-55-18.35L88,139.31,124.69,176ZM152,180.69,83.31,112,104,91.31,172.69,160Z"],"eraser":["M225,80.4,183.6,39a24,24,0,0,0-33.94,0L31,157.66a24,24,0,0,0,0,33.94l30.06,30.06A8,8,0,0,0,66.74,224H216a8,8,0,0,0,0-16h-84.7L225,114.34A24,24,0,0,0,225,80.4ZM108.68,208H70.05L42.33,180.28a8,8,0,0,1,0-11.31L96,115.31,148.69,168Zm105-105L160,156.69,107.31,104,161,50.34a8,8,0,0,1,11.32,0l41.38,41.38a8,8,0,0,1,0,11.31Z"],"undo":["M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39a3.07,3.07,0,0,1-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z"],"redo":["M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z"],"clear":["M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"],"caret":["M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"]};
  const SVG = "http://www.w3.org/2000/svg";
  const TOOLS = [
    { id: "laser", label: "雷射筆", key: "1", icon: "laser" },
    { id: "pen", label: "畫筆", key: "2", icon: "pen" },
    { id: "marker", label: "螢光筆", key: "3", icon: "marker" },
    { id: "eraser", label: "物件橡皮擦", key: "4", icon: "eraser" },
  ];
  const PALETTE = {
    pen: [["#202328", "墨黑"], ["#e03131", "紅色"], ["#1971c2", "藍色"], ["#2f9e44", "綠色"], ["#f08c00", "橘色"]],
    marker: [["#ffd43b", "黃色"], ["#69db7c", "綠色"], ["#ff8cc6", "粉紅色"], ["#74c0fc", "藍色"]],
  };
  /* 粗細以 1280 寬投影片為單位 */
  const SIZES = {
    pen: [[3, "細"], [6, "中"], [11, "粗"]],
    marker: [[14, "細"], [26, "中"], [42, "粗"]],
  };
  const MARKER_ALPHA = 0.4;
  const ERASER_R = 14;
  const TRAIL_MS = 450;
  const HISTORY = 100;

  function icon(name, extra) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (extra) svg.setAttribute("class", extra);
    for (const d of ICON[name]) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }
  function el(tag, cls, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs) for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    return node;
  }
  function button(cls, label, name) {
    const b = el("button", "annotate-btn " + cls, { type: "button", "aria-label": label, title: label });
    if (name) b.appendChild(icon(name));
    return b;
  }
  function readJSON(storage, key, fallback) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }
  function write(storage, key, value) {
    try {
      storage.setItem(key, value);
      return true;
    } catch (error) {
      /* 儲存空間不可用時只保留在記憶體 */
      return false;
    }
  }
  function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + alpha + ")";
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx - px, y = ay + t * dy - py;
    return Math.sqrt(x * x + y * y);
  }
  function editable(target) {
    return target instanceof Element && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName));
  }

  function init(deck) {
    if (/receiver|print-pdf|(?:[?&])view=print(?:&|$)/i.test(window.location.search)) return;
    const storeKey = "annotate:v2:" + window.location.pathname;
    const prefs = Object.assign(
      { collapsed: false, pen: { c: 0, s: 1 }, marker: { c: 0, s: 1 } },
      readJSON(window.localStorage, "annotate:prefs", {}) || {}
    );
    const loaded = readJSON(window.sessionStorage, storeKey, {});
    const store = loaded && typeof loaded === "object" ? loaded : {};
    const past = {};
    const future = {};
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let tool = null;
    let stroke = null;
    let erasing = null;
    let lastErase = null;
    let paused = false, overview = false, scroll = false;
    let hidden = false;
    let trail = [];
    let trailFrame = 0;

    const size = () => {
      const c = deck.getConfig();
      return { w: typeof c.width === "number" ? c.width : 960, h: typeof c.height === "number" ? c.height : 700 };
    };
    const slideId = () => {
      const i = deck.getIndices();
      return i.h + "." + (i.v || 0);
    };
    const frame = () => deck.getSlidesElement().getBoundingClientRect();
    const strokes = () => store[slideId()] || [];
    const unit = () => frame().width / size().w;

    /* DOM */
    const ink = el("canvas", "annotate-ink", { "aria-hidden": "true" });
    const ctx = ink.getContext("2d");
    const glow = el("canvas", "annotate-laser", { "aria-hidden": "true" });
    const gctx = glow.getContext("2d");
    const hit = el("div", "annotate-hit", { "aria-hidden": "true" });
    const dot = el("span", "annotate-laser-dot", { "aria-hidden": "true" });
    const cursor = el("span", "annotate-cursor", { "aria-hidden": "true" });

    const dock = el("div", "annotate-dock");
    const bar = el("div", "annotate-bar", { role: "toolbar", "aria-label": "簡報標註工具", "aria-orientation": "horizontal" });
    const fold = button("annotate-fold", "", "caret");
    const body = el("div", "annotate-body", { id: "annotate-body" });
    fold.setAttribute("aria-controls", "annotate-body");
    const toolButtons = {};
    const toolGroup = el("div", "annotate-group", { role: "group", "aria-label": "標註工具" });
    for (const t of TOOLS) {
      const b = button("annotate-tool", t.label + "（" + t.key + "）", t.icon);
      b.dataset.tool = t.id;
      b.addEventListener("click", () => setTool(tool === t.id ? null : t.id));
      toolButtons[t.id] = b;
      toolGroup.appendChild(b);
    }
    const undoBtn = button("annotate-undo", "復原（⌘Z ／ Ctrl+Z）", "undo");
    const redoBtn = button("annotate-redo", "重做（⇧⌘Z ／ Ctrl+Y）", "redo");
    const clearBtn = button("annotate-clear", "清除此頁標註", "clear");
    const sep = () => el("span", "annotate-sep", { "aria-hidden": "true" });
    body.append(toolGroup, sep(), undoBtn, redoBtn, clearBtn);
    const live = el("span", "annotate-live", { role: "status", "aria-live": "polite" });
    bar.append(body, fold, live);

    /* 畫筆設定面板：顏色與粗細 */
    const options = el("div", "annotate-options", { role: "group", "aria-label": "筆刷設定" });
    const colorGroup = el("div", "annotate-group", { role: "radiogroup", "aria-label": "顏色" });
    const sizeGroup = el("div", "annotate-group", { role: "radiogroup", "aria-label": "粗細" });
    options.append(colorGroup, sep(), sizeGroup);
    dock.append(options, bar);
    document.body.append(ink, glow, hit, cursor, dot, dock);

    function brush() {
      return tool === "pen" || tool === "marker" ? tool : null;
    }
    function current(kind) {
      const k = kind || brush() || "pen";
      const p = prefs[k];
      const colors = PALETTE[k], sizes = SIZES[k];
      return {
        kind: k,
        color: colors[Math.min(p.c, colors.length - 1)][0],
        width: sizes[Math.min(p.s, sizes.length - 1)][0],
      };
    }
    function savePrefs() {
      write(window.localStorage, "annotate:prefs", JSON.stringify(prefs));
    }
    function radio(group, items, selected, onPick, render) {
      group.replaceChildren();
      items.forEach((item, index) => {
        const b = button("annotate-swatch", item.label, null);
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", index === selected ? "true" : "false");
        b.tabIndex = index === selected ? 0 : -1;
        b.appendChild(render(item));
        b.addEventListener("click", () => onPick(index));
        b.addEventListener("keydown", (e) => {
          const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          e.stopPropagation();
          const next = (index + step + items.length) % items.length;
          onPick(next);
        });
        group.appendChild(b);
      });
    }
    function renderOptions() {
      const active = document.activeElement;
      const refocus = active && options.contains(active) ? (colorGroup.contains(active) ? colorGroup : sizeGroup) : null;
      paintOptions();
      if (refocus && !options.hidden) {
        const target = refocus.querySelector("[aria-checked=true]");
        if (target) target.focus();
      }
    }
    function paintOptions() {
      const k = brush();
      options.hidden = !k || hidden || prefs.collapsed;
      if (!k) return;
      const now = current(k);
      radio(colorGroup, PALETTE[k].map(([hex, name]) => ({ hex, label: (k === "pen" ? "畫筆顏色：" : "螢光筆顏色：") + name })), prefs[k].c, (i) => {
        prefs[k].c = i;
        savePrefs();
        sync();
      }, (item) => {
        const d = el("span", "annotate-color");
        d.style.background = k === "marker" ? rgba(item.hex, 0.85) : item.hex;
        return d;
      });
      radio(sizeGroup, SIZES[k].map(([w, name]) => ({ w, label: "粗細：" + name })), prefs[k].s, (i) => {
        prefs[k].s = i;
        savePrefs();
        sync();
      }, (item) => {
        const d = el("span", "annotate-size");
        const px = k === "marker" ? 6 + SIZES.marker.findIndex((s) => s[0] === item.w) * 6 : 4 + SIZES.pen.findIndex((s) => s[0] === item.w) * 5;
        d.style.width = d.style.height = px + "px";
        d.style.background = now.color;
        if (k === "marker") d.style.opacity = "0.7";
        return d;
      });
    }

    function announce(text) {
      live.textContent = "";
      window.setTimeout(() => { live.textContent = text; }, 30);
    }
    function save() {
      write(window.sessionStorage, storeKey, JSON.stringify(store));
    }
    function sync() {
      const id = slideId();
      dock.hidden = hidden;
      dock.dataset.tool = tool || "";
      bar.dataset.collapsed = prefs.collapsed ? "true" : "false";
      body.hidden = prefs.collapsed;
      fold.setAttribute("aria-expanded", prefs.collapsed ? "false" : "true");
      const foldLabel = prefs.collapsed ? "展開標註工具（T）" : "收合標註工具（T）";
      fold.setAttribute("aria-label", foldLabel);
      fold.title = foldLabel;
      for (const t of TOOLS) toolButtons[t.id].setAttribute("aria-pressed", tool === t.id ? "true" : "false");
      const k = brush();
      if (k) toolButtons[k].style.setProperty("--annotate-color", current(k).color);
      undoBtn.disabled = !(past[id] && past[id].length);
      redoBtn.disabled = !(future[id] && future[id].length);
      clearBtn.disabled = !strokes().length;
      hit.dataset.tool = tool || "";
      hit.classList.toggle("is-active", !!tool && !hidden);
      document.documentElement.classList.toggle("annotate-active", !!tool && !hidden);
      renderOptions();
      if (!tool || tool === "laser") cursor.classList.remove("is-on");
      if (tool !== "laser") dot.classList.remove("is-on", "is-down");
      if (tool === "pen" || tool === "marker" || tool === "eraser") styleCursor();
    }
    function setTool(next) {
      if (stroke) commitStroke();
      endErase();
      tool = next;
      if (tool && prefs.collapsed) {
        prefs.collapsed = false;
        savePrefs();
      }
      if (tool !== "laser") clearTrail();
      sync();
      draw();
      const t = TOOLS.find((x) => x.id === tool);
      announce(t ? "已切換到" + t.label : "已關閉標註工具");
    }

    /* 歷史 */
    function snapshot(id) {
      const list = past[id] || (past[id] = []);
      list.push((store[id] || []).slice());
      if (list.length > HISTORY) list.shift();
      future[id] = [];
    }
    function setStrokes(id, list) {
      if (list.length) store[id] = list;
      else delete store[id];
      save();
    }
    function undo() {
      const id = slideId();
      const list = past[id];
      if (!list || !list.length) return false;
      (future[id] || (future[id] = [])).push((store[id] || []).slice());
      setStrokes(id, list.pop());
      sync();
      draw();
      announce("已復原");
      return true;
    }
    function redo() {
      const id = slideId();
      const list = future[id];
      if (!list || !list.length) return false;
      (past[id] || (past[id] = [])).push((store[id] || []).slice());
      setStrokes(id, list.pop());
      sync();
      draw();
      announce("已重做");
      return true;
    }
    function clearSlide() {
      const id = slideId();
      if (!strokes().length) return;
      snapshot(id);
      setStrokes(id, []);
      sync();
      draw();
      announce("已清除此頁標註，可按復原還原");
    }

    /* 繪製 */
    function fit(canvas) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
    }
    function resize() {
      scroll = typeof deck.isScrollView === "function" && deck.isScrollView();
      updateHidden();
      fit(ink);
      fit(glow);
      draw();
    }
    function paint(s, r, u) {
      const p = s.p;
      if (!p || p.length < 2) return;
      ctx.globalCompositeOperation = s.k === "marker" ? "multiply" : "source-over";
      ctx.strokeStyle = s.k === "marker" ? rgba(s.c, MARKER_ALPHA) : s.c;
      ctx.lineWidth = s.w * u;
      ctx.lineCap = s.k === "marker" ? "butt" : "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(r.left + p[0] * r.width, r.top + p[1] * r.height);
      if (p.length === 2) {
        ctx.lineCap = "round";
        ctx.lineTo(r.left + p[0] * r.width + 0.01, r.top + p[1] * r.height);
      }
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(r.left + p[i] * r.width, r.top + p[i + 1] * r.height);
      ctx.stroke();
    }
    function draw() {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ink.width, ink.height);
      if (hidden) return;
      const r = frame();
      const u = r.width / size().w;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const list = strokes();
      const skip = erasing ? erasing.removed : null;
      for (const s of list) {
        if (skip && skip.has(s)) continue;
        paint(s, r, u);
      }
      if (stroke) paint(stroke, r, u);
      ctx.globalCompositeOperation = "source-over";
    }
    function norm(e) {
      const r = frame();
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    }
    function commitStroke() {
      if (!stroke) return;
      const id = slideId();
      snapshot(id);
      setStrokes(id, strokes().concat([stroke]));
      stroke = null;
      sync();
      draw();
    }

    /* 物件橡皮擦：碰到的整條筆跡一起移除 */
    function eraseAt(x, y) {
      if (!erasing) return;
      const r = frame();
      const u = r.width / size().w;
      const from = lastErase || { x, y };
      const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / (ERASER_R / 2)));
      let changed = false;
      for (const s of strokes()) {
        if (erasing.removed.has(s)) continue;
        const reach = ERASER_R + (s.w * u) / 2;
        const p = s.p;
        let touched = false;
        for (let k = 0; k <= steps && !touched; k++) {
          const qx = from.x + ((x - from.x) * k) / steps, qy = from.y + ((y - from.y) * k) / steps;
          if (p.length === 2) {
            touched = Math.hypot(r.left + p[0] * r.width - qx, r.top + p[1] * r.height - qy) <= reach;
          }
          for (let i = 2; i < p.length && !touched; i += 2) {
            touched = segDist(qx, qy, r.left + p[i - 2] * r.width, r.top + p[i - 1] * r.height, r.left + p[i] * r.width, r.top + p[i + 1] * r.height) <= reach;
          }
        }
        if (touched) {
          erasing.removed.add(s);
          changed = true;
        }
      }
      lastErase = { x, y };
      if (changed) draw();
    }
    function endErase() {
      if (!erasing) return;
      const removed = erasing.removed;
      erasing = null;
      lastErase = null;
      if (!removed.size) return;
      const id = slideId();
      snapshot(id);
      setStrokes(id, strokes().filter((s) => !removed.has(s)));
      sync();
      draw();
      announce("已擦除 " + removed.size + " 條筆跡");
    }

    /* 雷射筆：同步繪製，rAF 只負責淡出 */
    function drawTrail() {
      trailFrame = 0;
      const dpr = window.devicePixelRatio || 1;
      const now = performance.now();
      trail = trail.filter((p) => now - p.t < TRAIL_MS);
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.clearRect(0, 0, glow.width, glow.height);
      gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gctx.lineCap = "round";
      gctx.lineJoin = "round";
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1], b = trail[i];
        if (b.gap) continue;
        const life = 1 - (now - b.t) / TRAIL_MS;
        gctx.strokeStyle = "rgba(255,40,40," + (life * 0.85).toFixed(3) + ")";
        gctx.lineWidth = 2 + life * 5;
        gctx.shadowColor = "rgba(255,30,30,.9)";
        gctx.shadowBlur = 10 * life;
        gctx.beginPath();
        gctx.moveTo(a.x, a.y);
        gctx.lineTo(b.x, b.y);
        gctx.stroke();
      }
      if (trail.length) trailFrame = window.requestAnimationFrame(drawTrail);
    }
    function addTrail(x, y, gap) {
      if (reduced.matches) return;
      trail.push({ x, y, t: performance.now(), gap });
      window.cancelAnimationFrame(trailFrame);
      drawTrail();
    }
    function clearTrail() {
      trail = [];
      window.cancelAnimationFrame(trailFrame);
      trailFrame = 0;
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.clearRect(0, 0, glow.width, glow.height);
    }
    function moveDot(x, y) {
      dot.style.transform = "translate(" + x + "px," + y + "px)";
      dot.classList.add("is-on");
    }

    /* 游標預覽：畫筆顯示實際粗細與顏色，橡皮擦顯示範圍 */
    function styleCursor() {
      let d;
      if (tool === "eraser") {
        d = ERASER_R * 2;
        cursor.style.background = "";
        cursor.style.borderColor = "";
      } else {
        const now = current(tool);
        d = Math.max(6, now.width * unit());
        cursor.style.background = tool === "marker" ? rgba(now.color, 0.45) : now.color;
        cursor.style.borderColor = "rgba(255,255,255,.9)";
      }
      cursor.dataset.tool = tool || "";
      cursor.style.width = cursor.style.height = d + "px";
      cursor.style.marginLeft = cursor.style.marginTop = -d / 2 + "px";
    }
    function moveCursor(e) {
      if (e.pointerType !== "mouse") {
        cursor.classList.remove("is-on");
        return;
      }
      cursor.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)";
      cursor.classList.add("is-on");
    }

    /* 指標事件 */
    hit.addEventListener("pointerdown", (e) => {
      if (!tool || e.button > 0) return;
      e.preventDefault();
      try {
        hit.setPointerCapture(e.pointerId);
      } catch (error) {
        /* 指標已釋放時不需要捕捉 */
      }
      if (tool === "laser") {
        dot.classList.add("is-down");
        moveDot(e.clientX, e.clientY);
        addTrail(e.clientX, e.clientY, true);
      } else if (tool === "eraser") {
        erasing = { removed: new Set() };
        lastErase = null;
        eraseAt(e.clientX, e.clientY);
      } else {
        const now = current(tool);
        stroke = { k: tool, c: now.color, w: now.width, p: norm(e) };
        draw();
      }
    });
    hit.addEventListener("pointermove", (e) => {
      if (!tool) return;
      if (tool === "laser") {
        moveDot(e.clientX, e.clientY);
        addTrail(e.clientX, e.clientY, false);
        return;
      }
      moveCursor(e);
      if (tool === "eraser") {
        if (erasing) eraseAt(e.clientX, e.clientY);
        return;
      }
      if (!stroke) return;
      const [x, y] = norm(e);
      const p = stroke.p;
      if (e.shiftKey) {
        stroke.p = [p[0], p[1], x, y];
      } else {
        const r = frame();
        const dx = (x - p[p.length - 2]) * r.width, dy = (y - p[p.length - 1]) * r.height;
        if (dx * dx + dy * dy < 2.25) return;
        p.push(x, y);
      }
      draw();
    });
    const release = (e) => {
      if (tool === "laser") {
        dot.classList.remove("is-down");
        if (e.pointerType !== "mouse") dot.classList.remove("is-on");
      }
      if (stroke) commitStroke();
      endErase();
    };
    hit.addEventListener("pointerup", release);
    hit.addEventListener("pointercancel", release);
    hit.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      cursor.classList.remove("is-on");
      dot.classList.remove("is-on");
    });
    hit.addEventListener("contextmenu", (e) => {
      if (tool) e.preventDefault();
    });

    /* 工具列互動 */
    fold.addEventListener("click", () => {
      prefs.collapsed = !prefs.collapsed;
      savePrefs();
      if (prefs.collapsed && tool) setTool(null);
      else sync();
    });
    undoBtn.addEventListener("click", undo);
    redoBtn.addEventListener("click", redo);
    clearBtn.addEventListener("click", clearSlide);
    /* 滑鼠點擊後放開焦點，避免空白鍵再次觸發按鈕；鍵盤操作保留焦點 */
    dock.addEventListener("pointerup", (e) => {
      if (!(e.target instanceof Element)) return;
      const b = e.target.closest("button");
      if (b) window.setTimeout(() => b.blur(), 0);
    });

    /* 鍵盤 */
    for (const t of TOOLS) {
      deck.addKeyBinding({ keyCode: 48 + Number(t.key), key: t.key, description: t.label }, () => setTool(tool === t.id ? null : t.id));
    }
    deck.addKeyBinding({ keyCode: 84, key: "T", description: "展開／收合標註工具列" }, () => fold.click());
    window.addEventListener("keydown", (e) => {
      if (hidden || editable(e.target)) return;
      if (dock.contains(e.target) && (e.key === " " || e.key === "Enter")) {
        e.stopPropagation();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && (key === "z" || key === "y")) {
        const done = key === "y" || e.shiftKey ? redo() : undo();
        if (done) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (e.key === "Escape" && tool) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setTool(null);
        return;
      }
      const k = brush();
      if (k && !mod && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        e.stopPropagation();
        const max = SIZES[k].length - 1;
        prefs[k].s = Math.max(0, Math.min(max, prefs[k].s + (e.key === "]" ? 1 : -1)));
        savePrefs();
        sync();
        announce("粗細：" + SIZES[k][prefs[k].s][1]);
      }
    }, true);

    /* Reveal 事件 */
    function updateHidden() {
      hidden = paused || overview || scroll;
      if (hidden) {
        stroke = null;
        erasing = null;
        tool = null;
        clearTrail();
      }
      sync();
    }
    const refresh = () => {
      stroke = null;
      erasing = null;
      sync();
      draw();
    };
    deck.on("slidechanged", refresh);
    deck.on("resize", resize);
    deck.on("ready", resize);
    deck.on("overviewshown", () => { overview = true; updateHidden(); draw(); });
    deck.on("overviewhidden", () => { overview = false; updateHidden(); draw(); });
    deck.on("paused", () => { paused = true; updateHidden(); draw(); });
    deck.on("resumed", () => { paused = false; updateHidden(); draw(); });
    window.addEventListener("resize", resize);
    window.setTimeout(resize, 400);
    resize();
  }

  window.RevealAnnotate = function () {
    return { id: "annotate", init: init };
  };
})();
