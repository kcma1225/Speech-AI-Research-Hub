<script lang="ts">
  import { untrack } from "svelte";
  import { EditorView } from "@codemirror/view";
  import type { Extension } from "@codemirror/state";
  import type * as Y from "yjs";
  import { CheckCheck, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { session as auth } from "#lib/stores/session.svelte.ts";
  import { openCollab } from "#lib/collab/session.svelte.ts";
  import ConnectionStatus from "#lib/collab/ConnectionStatus.svelte";
  import PresenceAvatars from "#lib/collab/PresenceAvatars.svelte";
  import CodeEditor from "#lib/editor/CodeEditor.svelte";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import { revealHunk, suggestionReview } from "#lib/components/suggest/extension.ts";
  import { SuggestionReview } from "#lib/components/suggest/review.svelte.ts";
  import type { LiveHunk } from "#lib/components/suggest/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { viewer, type ArtifactRef } from "#lib/agent/viewer.ts";
  import type { ViewerEntry } from "#lib/agent/viewer-state.svelte.ts";
  import { blockForLine, firstChange, flashElement, lineAt, reducedMotion } from "./util.ts";

  /**
   * Live, read-only view of a collaborative text (Yjs document, read through the normal `/api/collab` authorization):
   * remote edits (the AI's accepted suggestions, autopilot, other members) appear as they happen, pending suggestions
   * are marked inline with 接受／拒絕 for people who may review them. Markdown can be shown rendered (「閱讀」) or as
   * source with the marks (「標記」). With 跟隨 AI on, the view jumps to each remote change.
   */
  let {
    docName,
    targetType,
    targetId,
    entry,
    artifact,
    language = "markdown",
    rendered = false,
    label,
    onMessage,
  }: {
    docName: string;
    targetType: string;
    targetId: string;
    entry: ViewerEntry;
    /** What `markUpdated` reports (the shown artifact). */
    artifact: ArtifactRef;
    language?: "markdown" | "plain" | Extension;
    /** Offer the rendered Markdown mode. */
    rendered?: boolean;
    label: string;
    onMessage?: (payload: Record<string, unknown>) => void;
  } = $props();

  const me = auth.user!;
  const initial = untrack(() => ({ docName, targetType, targetId }));
  const collab = openCollab(initial.docName, { id: me.id, name: me.name });
  const review = new SuggestionReview({ targetType: initial.targetType, targetId: initial.targetId, doc: collab.doc, text: collab.text, onError: (m) => toasts.show(m, "error") });
  let view = $state<EditorView | null>(null);
  let rendering = $state<HTMLElement | null>(null);
  let mode = $state<"read" | "marks">(untrack(() => (rendered ? "read" : "marks")));
  let text = $state("");
  let textTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const off = collab.onMessage((msg) => {
      if (msg.type === "suggestions") void review.refresh();
      untrack(() => onMessage?.(msg));
    });
    void review.refresh();
    const observer = (event: Y.YTextEvent) => {
      clearTimeout(textTimer);
      textTimer = setTimeout(() => (text = collab.text.toString()), 120);
      if (event.transaction.local || !collab.synced) return;
      const at = firstChange(event.delta as { retain?: number; insert?: unknown; delete?: number }[]);
      untrack(() => {
        viewer.markUpdated(artifact);
        if (at !== null && viewer.follow) setTimeout(() => reveal(at), 160);
      });
    };
    collab.text.observe(observer);
    text = collab.text.toString();
    return () => {
      off();
      collab.text.unobserve(observer);
      clearTimeout(textTimer);
      review.destroy();
      collab.destroy();
    };
  });
  $effect(() => {
    if (collab.synced) text = collab.text.toString();
  });
  $effect(() => review.attach(view));

  function reveal(pos: number) {
    if (mode === "marks" && view) {
      const at = Math.min(pos, view.state.doc.length);
      view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
      return;
    }
    if (rendering) {
      const el = blockForLine(rendering, lineAt(collab.text.toString(), pos));
      if (el) {
        el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
        flashElement(el);
      }
    }
  }

  // Focus requests: a suggestion (switch to the marks and scroll to its first hunk) or a line.
  let lastNonce = -1;
  $effect(() => {
    const e = entry;
    const live = review.live;
    const ready = !!view;
    untrack(() => {
      if (e.nonce === lastNonce || !collab.synced) return;
      const sid = e.focus.suggestionId;
      if (sid) {
        const hunk = live.find((h) => h.suggestionId === sid);
        if (!hunk) return; // wait for the suggestion list
        mode = "marks";
        if (!ready) return;
        lastNonce = e.nonce;
        setTimeout(() => view && revealHunk(view, hunk), 60);
      } else if (e.focus.line) {
        lastNonce = e.nonce;
        const lines = collab.text.toString().split("\n");
        const pos = lines.slice(0, e.focus.line - 1).reduce((n, l) => n + l.length + 1, 0);
        reveal(pos);
      } else lastNonce = e.nonce;
    });
  });
  // Opening with pending suggestions shows the marks.
  let marked = false;
  $effect(() => {
    if (!marked && review.loaded && review.live.length && rendered) {
      marked = true;
      mode = "marks";
    }
  });

  const pending = $derived(review.live.filter((h) => !h.stale).length);
  const pendingIds = $derived([...new Set(review.live.map((h) => h.suggestionId))]);
  async function decideAll(accept: boolean) {
    for (const id of pendingIds) await (accept ? review.acceptAll(id) : review.rejectAll(id));
  }
  const labels = {
    get accept() {
      return t("suggest.accept");
    },
    get reject() {
      return t("suggest.reject");
    },
    get stale() {
      return t("suggest.stale");
    },
    by: (h: LiveHunk) => t("suggest.by", { title: h.title || t("suggest.untitled"), name: h.author ?? "AI" }),
  };
  const extensions = [suggestionReview(review.actions(labels))];
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
    {#if rendered}
      <Segmented guardIgnore bind:value={mode} label={t("viewer.mode")} options={[{ value: "read", label: t("viewer.modeRead") }, { value: "marks", label: t("viewer.modeMarks") }]} />
    {/if}
    <span class="min-w-0 flex-1"></span>
    <PresenceAvatars peers={collab.peers} />
    <ConnectionStatus session={collab} compact />
  </div>
  {#if pending || review.live.length}
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--pill-butter)_55%,transparent)] px-3 py-2" role="status">
      <span class="min-w-0 flex-1 text-[12.5px] font-medium text-[var(--pill-butter-ink)]">{t("viewer.pending", { n: review.live.length })}</span>
      {#if review.canReview && pending}
        <Button size="sm" variant="ghost" disabled={review.busy} onclick={() => decideAll(false)}><X />{t("viewer.rejectAll")}</Button>
        <Button size="sm" variant="primary" disabled={review.busy} onclick={() => decideAll(true)}><CheckCheck />{t("viewer.acceptAll")}</Button>
      {/if}
    </div>
  {/if}
  <div class="relative min-h-0 flex-1">
    {#if !collab.synced && collab.status !== "denied"}
      <div class="absolute inset-0 z-10 flex flex-col gap-2 bg-canvas p-4" aria-busy="true">
        <div class="h-4 w-1/2 animate-pulse rounded bg-surface-3"></div>
        <div class="h-4 w-5/6 animate-pulse rounded bg-surface-2"></div>
        <div class="h-4 w-2/3 animate-pulse rounded bg-surface-2"></div>
      </div>
    {:else if collab.status === "denied"}
      <p class="m-4 rounded-2xl bg-danger-soft p-4 text-[13px] text-danger" role="alert">{t("viewer.denied")}</p>
    {/if}
    <div class="h-full {mode === 'marks' ? '' : 'hidden'}">
      <CodeEditor bind:view collab={{ text: collab.text, awareness: collab.awareness }} readOnly {language} {label} {extensions} fontSize={14} mono={language !== "markdown"} class="h-full" />
    </div>
    {#if mode === "read"}
      <div class="h-full overflow-y-auto px-5 py-4">
        <MarkdownView bind:element={rendering} source={text} sourceLines fontSize={14.5} class="viewer-md" />
      </div>
    {/if}
  </div>
</div>

<style>
  :global(.viewer-md .viewer-hl),
  :global(.viewer-hl) {
    animation: viewer-hl 1.8s ease-out;
    border-radius: 6px;
  }
  @keyframes -global-viewer-hl {
    0%,
    30% {
      background: color-mix(in srgb, var(--pill-butter) 85%, transparent);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--pill-butter) 85%, transparent);
    }
    100% {
      background: transparent;
      box-shadow: 0 0 0 4px transparent;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.viewer-hl) {
      animation: none;
      background: color-mix(in srgb, var(--pill-butter) 60%, transparent);
    }
  }
</style>
