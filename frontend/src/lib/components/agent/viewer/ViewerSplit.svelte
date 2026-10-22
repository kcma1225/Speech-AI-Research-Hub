<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { MessagesSquare, FileText } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { ChatSession } from "#lib/agent/chat.svelte.ts";
  import {
    artifactFromUrl, artifactsOfCall, findPageCites, isWriteCall, notifyArtifactChanged, openArtifact, paperBefore, refreshArtifact, viewer,
  } from "#lib/agent/viewer.ts";
  import type { ViewerLayout } from "#lib/agent/viewer-state.svelte.ts";
  import ViewerPanel from "./ViewerPanel.svelte";

  /**
   * Chat + 「文件檢視器」. Layout by width: side by side with a draggable divider (page ≥ 1280 px, Ask-AI panel ≥ 1024 px,
   * width remembered), an overlay drawer on tablets (page 768–1279 px), a 對話／文件 tab switch on phones.
   * It also (1) opens hub links clicked in the chat (attachment chips, tool links, answer links) in the viewer —
   * modifier/middle clicks still navigate; (2) turns page citations (`p. 5`, `第 5 頁`) of answers about a paper into
   * chips that open it at that page; (3) opens / refreshes a document when an AI write of this conversation touches it.
   */
  let { session, variant = "page", children }: { session: ChatSession; variant?: "page" | "panel"; children: Snippet } = $props();

  let vw = $state(typeof window !== "undefined" ? window.innerWidth : 1280);
  const layout = $derived<ViewerLayout>(variant === "panel" ? (vw >= 1024 ? "split" : "tabs") : vw >= 1280 ? "split" : vw >= 768 ? "drawer" : "tabs");
  $effect(() => {
    viewer.layout = layout;
  });
  const showing = $derived(viewer.open && !!viewer.current);

  // The viewer shows this conversation's own documents: switching restores them, a new chat starts empty, and the
  // conversation a new chat turns into keeps what it opened.
  $effect(() => {
    const id = session.id;
    untrack(() => viewer.bindConversation(id, { adopt: !!id && session.createdId === id }));
  });

  // ---------------------------------------------------------------- AI writes → open / refresh
  let seen = new Map<string, string>();
  let primed: string | null | undefined = undefined;
  $effect(() => {
    const id = session.id;
    const loading = session.loading;
    const calls = session.toolCalls.map((c) => ({ c, status: c.status }));
    untrack(() => {
      if (loading) return;
      if (primed !== id) {
        // Calls that were already there when the conversation loaded never open anything.
        primed = id;
        seen = new Map(calls.map((x) => [x.c.id, x.status]));
        return;
      }
      for (const { c, status } of calls) {
        const prev = seen.get(c.id);
        seen.set(c.id, status);
        if (status !== "done" || prev === "done") continue;
        for (const a of artifactsOfCall(c)) {
          if (a.title) viewer.setTitle(a.ref, a.title);
          if (isWriteCall(c)) notifyArtifactChanged(a.ref, { focus: a.focus });
          else if (viewer.isCurrent(a.ref) && Object.keys(a.focus).length) refreshArtifact(a.ref, { focus: a.focus });
          else viewer.remember(a.ref);
        }
      }
    });
  });

  // ---------------------------------------------------------------- links in the chat → viewer
  let chat = $state<HTMLElement | null>(null);
  function onClickCapture(e: MouseEvent) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    const cite = el?.closest?.<HTMLElement>("[data-viewer-page]");
    if (cite?.dataset.viewerPaper) {
      e.preventDefault();
      e.stopPropagation();
      openArtifact({ kind: "paper", id: cite.dataset.viewerPaper }, { focus: { page: Number(cite.dataset.viewerPage) } });
      return;
    }
    const a = el?.closest?.<HTMLAnchorElement>("a[href]");
    if (!a || !chat?.contains(a)) return;
    const parsed = artifactFromUrl(a.getAttribute("href") ?? "");
    if (!parsed) return;
    e.preventDefault();
    e.stopPropagation();
    openArtifact(parsed.ref, { focus: parsed.focus });
  }

  // ---------------------------------------------------------------- page citations → chips
  const SKIP = "code,pre,a,button,kbd,.katex,.md-math,[data-viewer-page]";
  let frame = 0;
  function enhance() {
    frame = 0;
    if (!chat) return;
    const roles = new Map(session.messages.map((m) => [m.id, m.role]));
    for (const wrap of chat.querySelectorAll<HTMLElement>("[data-msg-id]")) {
      const id = wrap.dataset.msgId!;
      if (roles.get(id) !== "assistant") continue;
      const blocks = wrap.querySelectorAll<HTMLElement>(".md");
      if (!blocks.length || !findPageCites(wrap.textContent ?? "").length) continue;
      const paper = paperBefore(session.messages, session.toolCalls, id) ?? (viewer.current?.ref.kind === "paper" ? viewer.current.ref.id : null);
      if (paper) blocks.forEach((md) => wrapCites(md, paper));
    }
  }
  function wrapCites(root: HTMLElement, paperId: string) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      if (text.parentElement?.closest(SKIP) || !findPageCites(text.data).length) continue;
      nodes.push(text);
    }
    for (const node of nodes) {
      const cites = findPageCites(node.data);
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const c of cites) {
        if (c.start > at) frag.append(node.data.slice(at, c.start));
        const b = document.createElement("button");
        b.type = "button";
        b.className = "viewer-cite";
        b.dataset.viewerPage = String(c.page);
        b.dataset.viewerPaper = paperId;
        b.title = t("viewer.citeOpen", { n: c.page });
        b.textContent = node.data.slice(c.start, c.end);
        frag.append(b);
        at = c.end;
      }
      if (at < node.data.length) frag.append(node.data.slice(at));
      node.replaceWith(frag);
    }
  }
  $effect(() => {
    const el = chat;
    if (!el) return;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(enhance);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    schedule();
    return () => {
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
  });
  // Tool calls arriving later can name the paper of an earlier answer.
  $effect(() => {
    void session.toolCalls.length;
    void session.messages.length;
    if (chat && !frame) frame = requestAnimationFrame(enhance);
  });

  // ---------------------------------------------------------------- divider
  const WIDTH_KEY = `hub.viewer.width.${untrack(() => variant)}`;
  let box = $state(0);
  let width = $state(readWidth());
  function readWidth() {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }
  const minChat = $derived(variant === "panel" ? 400 : 420);
  const fallback = $derived(variant === "panel" ? box - 460 : Math.round(box * 0.52));
  const viewerWidth = $derived(Math.round(Math.max(360, Math.min(width || fallback, box - minChat))));
  let dragging = $state(false);
  function startDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    const right = (handle.parentElement as HTMLElement).getBoundingClientRect().right;
    const move = (ev: PointerEvent) => (width = Math.max(360, Math.min(right - ev.clientX, box - minChat)));
    const up = () => {
      dragging = false;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      saveWidth();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }
  function saveWidth() {
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(viewerWidth)));
    } catch {}
  }
  function dividerKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 96 : 32;
    if (e.key === "ArrowLeft") width = Math.min(viewerWidth + step, box - minChat);
    else if (e.key === "ArrowRight") width = Math.max(360, viewerWidth - step);
    else if (e.key === "Home") width = box - minChat;
    else if (e.key === "End") width = 360;
    else return;
    e.preventDefault();
    saveWidth();
  }
  function resetWidth() {
    width = 0;
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {}
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === "Escape" && layout === "drawer" && showing && !e.defaultPrevented && !(e.target as HTMLElement | null)?.closest?.("[role=dialog],[role=menu],[role=listbox]")) viewer.closeViewer();
  }
</script>

<svelte:window bind:innerWidth={vw} onkeydown={onWindowKey} />

<div class="relative flex h-full min-h-0 flex-col" data-viewer-host={variant}>
  {#if layout === "tabs" && viewer.current}
    <div class="flex shrink-0 gap-1 border-b border-line bg-surface px-2 py-1.5" role="tablist" aria-label={t("viewer.tabs")}>
      <button type="button" role="tab" aria-selected={!showing} class="tab" data-active={!showing || undefined} onclick={() => viewer.closeViewer()}><MessagesSquare class="size-4" />{t("viewer.tabChat")}</button>
      <button type="button" role="tab" aria-selected={showing} class="tab" data-active={showing || undefined} onclick={() => viewer.showDocument()}>
        <FileText class="size-4" />{t("viewer.tabDoc")}
        {#if viewer.unseen && !showing}<span class="badge grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink px-1 text-[10px] font-semibold text-primary-ink" aria-label={t("viewer.unseen", { n: viewer.unseen })}>{viewer.unseen > 9 ? "9+" : viewer.unseen}</span>{/if}
      </button>
    </div>
  {/if}

  <div class="relative flex min-h-0 flex-1" bind:clientWidth={box}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div bind:this={chat} onclickcapture={onClickCapture} class="min-h-0 min-w-0 flex-1 {layout === 'tabs' && showing ? 'hidden' : ''}">
      {@render children()}
    </div>

    {#if showing && layout === "split"}
      <!-- A focusable separator is an interactive widget (WAI-ARIA window splitter). -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="divider relative z-10 w-0 shrink-0 cursor-col-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("viewer.resize")}
        aria-valuenow={viewerWidth}
        aria-valuemin={360}
        aria-valuemax={Math.max(360, box - minChat)}
        tabindex="0"
        data-dragging={dragging || undefined}
        onpointerdown={startDrag}
        onkeydown={dividerKey}
        ondblclick={resetWidth}
      ></div>
      <aside class="viewer-side min-h-0 shrink-0 {variant === 'page' ? 'mb-3 ml-3 overflow-hidden rounded-[var(--radius-card)] border border-line shadow-card' : 'border-l border-line'}" style="width:{viewerWidth}px">
        <ViewerPanel {session} />
      </aside>
    {:else if showing && layout === "drawer"}
      <button type="button" class="scrim absolute inset-0 z-20 bg-[var(--overlay)]" aria-label={t("viewer.close")} onclick={() => viewer.closeViewer()}></button>
      <aside class="drawer absolute inset-y-0 right-0 z-30 w-[min(720px,92%)] border-l border-line shadow-pop">
        <ViewerPanel {session} onBack={() => viewer.closeViewer()} />
      </aside>
    {:else if showing && layout === "tabs"}
      <div class="min-h-0 min-w-0 flex-1"><ViewerPanel {session} /></div>
    {/if}
  </div>
  {#if dragging}<div class="fixed inset-0 z-50 cursor-col-resize"></div>{/if}
</div>

<style>
  .tab {
    position: relative;
    display: inline-flex;
    flex: 1;
    min-height: 40px;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 500;
    color: var(--ink-3);
    transition: background-color 150ms, color 150ms;
  }
  .tab[data-active] {
    background: var(--surface-3);
    color: var(--ink);
  }
  .divider::before {
    content: "";
    position: absolute;
    inset: 0 -6px;
  }
  .divider::after {
    content: "";
    position: absolute;
    top: 50%;
    left: -2px;
    width: 4px;
    height: 40px;
    margin-top: -20px;
    border-radius: 999px;
    background: var(--line-2);
    opacity: 0;
    transition: opacity 150ms;
  }
  .divider:hover::after,
  .divider:focus-visible::after,
  .divider[data-dragging]::after {
    opacity: 1;
  }
  .divider:focus-visible {
    outline: none;
  }
  .viewer-side {
    animation: side-in 220ms cubic-bezier(0.2, 0, 0, 1);
  }
  .drawer {
    animation: drawer-in 240ms cubic-bezier(0.2, 0, 0, 1);
  }
  .scrim {
    animation: fade 160ms ease-out;
  }
  @keyframes side-in {
    from {
      opacity: 0;
      transform: translateX(16px);
    }
  }
  @keyframes drawer-in {
    from {
      transform: translateX(100%);
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  :global(.viewer-cite) {
    display: inline;
    padding: 0 5px;
    margin: 0 1px;
    border-radius: 6px;
    background: var(--pill-sky);
    color: var(--pill-sky-ink);
    font-size: 0.92em;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  :global(.viewer-cite:hover),
  :global(.viewer-cite:focus-visible) {
    outline: 2px solid color-mix(in srgb, var(--pill-sky-ink) 40%, transparent);
    outline-offset: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .viewer-side,
    .drawer,
    .scrim {
      animation: none;
    }
    .tab {
      transition: none;
    }
  }
</style>
