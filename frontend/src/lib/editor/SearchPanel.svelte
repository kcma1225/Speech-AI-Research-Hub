<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, setSearchQuery } from "@codemirror/search";
  import type { EditorView, ViewUpdate } from "@codemirror/view";
  import { ArrowDown, ArrowUp, CaseSensitive, Regex, Replace, ReplaceAll, WholeWord, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";

  /**
   * Find & replace panel for CodeMirror (replaces the built-in panel so it uses our controls: toggle buttons
   * instead of native checkboxes, ≥ 40 px targets on touch, match counter). Mounted by `searchPanel()`.
   */
  let { view, registerUpdate }: { view: EditorView; registerUpdate: (fn: (u: ViewUpdate) => void) => void } = $props();

  const initial = untrack(() => getSearchQuery(view.state));
  const readOnly = untrack(() => view.state.readOnly);
  let search = $state(initial.search);
  let replace = $state(initial.replace);
  let caseSensitive = $state(initial.caseSensitive);
  let regexp = $state(initial.regexp);
  let wholeWord = $state(initial.wholeWord);
  let showReplace = $state(!readOnly && !!initial.replace);
  let count = $state<{ current: number; total: number; capped: boolean }>({ current: 0, total: 0, capped: false });
  let input = $state<HTMLInputElement | null>(null);

  function commit() {
    const query = new SearchQuery({ search, replace, caseSensitive, regexp, wholeWord });
    if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) });
    recount();
  }

  function recount() {
    const query = getSearchQuery(view.state);
    if (!query.search || !query.valid) return void (count = { current: 0, total: 0, capped: false });
    const cursor = query.getCursor(view.state);
    const head = view.state.selection.main;
    let total = 0;
    let current = 0;
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      total++;
      if (next.value.from === head.from && next.value.to === head.to) current = total;
      if (total >= 999) return void (count = { current, total, capped: true });
    }
    count = { current, total, capped: false };
  }

  onMount(() => {
    registerUpdate(u => {
      if (u.docChanged || u.selectionSet) recount();
      const q = getSearchQuery(u.state);
      if (q.search !== search && document.activeElement !== input) search = q.search;
    });
    input?.focus();
    input?.select();
    recount();
  });

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === "Enter" && e.target === input) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
      recount();
    } else if (e.key === "Enter" && (e.target as HTMLElement).dataset.replace !== undefined) {
      e.preventDefault();
      (e.metaKey || e.ctrlKey ? replaceAll : replaceNext)(view);
      recount();
    }
  }

  const run = (fn: (v: EditorView) => boolean) => () => {
    commit();
    fn(view);
    recount();
  };
  const toggle = "grid size-10 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink aria-pressed:bg-ink aria-pressed:text-surface lg:size-8 [&_svg]:size-4";
  const button = "grid size-10 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40 lg:size-8 [&_svg]:size-4";
  const field = "h-10 min-w-0 flex-1 rounded-xl border border-line-2 bg-surface px-3 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-ink lg:h-8 lg:text-[13px]";
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="flex flex-col gap-1.5 px-2 py-2" onkeydown={key} role="search" aria-label={t("mdx.find")}>
  <div class="flex items-center gap-1">
    <input
      bind:this={input}
      bind:value={search}
      oninput={commit}
      class={field}
      placeholder={t("mdx.findPlaceholder")}
      aria-label={t("mdx.findPlaceholder")}
      autocomplete="off"
      spellcheck="false"
      {...{ "main-field": "true" }}
    />
    <span class="w-16 shrink-0 text-center text-[12px] text-ink-3 tabular-nums" aria-live="polite">
      {#if search}{count.total ? `${count.current || "–"}/${count.total}${count.capped ? "+" : ""}` : t("mdx.noMatches")}{/if}
    </span>
    <button type="button" class={button} aria-label={t("mdx.findPrev")} title={t("mdx.findPrev")} disabled={!count.total} onclick={run(findPrevious)}><ArrowUp /></button>
    <button type="button" class={button} aria-label={t("mdx.findNext")} title={t("mdx.findNext")} disabled={!count.total} onclick={run(findNext)}><ArrowDown /></button>
    {#if !readOnly}
      <button type="button" class={toggle} aria-label={t("mdx.replace")} title={t("mdx.replace")} aria-pressed={showReplace} onclick={() => (showReplace = !showReplace)}><Replace /></button>
    {/if}
    <button type="button" class={button} aria-label={t("common.close")} onclick={() => (closeSearchPanel(view), view.focus())}><X /></button>
  </div>
  <div class="flex flex-wrap items-center gap-1">
    {#if showReplace && !readOnly}
      <input bind:value={replace} oninput={commit} data-replace class="{field} basis-40" placeholder={t("mdx.replacePlaceholder")} aria-label={t("mdx.replacePlaceholder")} autocomplete="off" spellcheck="false" />
      <button type="button" class={button} aria-label={t("mdx.replaceOne")} title={t("mdx.replaceOne")} disabled={!count.total} onclick={run(replaceNext)}><Replace /></button>
      <button type="button" class={button} aria-label={t("mdx.replaceAll")} title={t("mdx.replaceAll")} disabled={!count.total} onclick={run(replaceAll)}><ReplaceAll /></button>
    {/if}
    <div class="ml-auto flex items-center gap-0.5" role="group" aria-label={t("mdx.findOptions")}>
      <button type="button" class={toggle} aria-pressed={caseSensitive} aria-label={t("mdx.matchCase")} title={t("mdx.matchCase")} onclick={() => ((caseSensitive = !caseSensitive), commit())}><CaseSensitive /></button>
      <button type="button" class={toggle} aria-pressed={wholeWord} aria-label={t("mdx.wholeWord")} title={t("mdx.wholeWord")} onclick={() => ((wholeWord = !wholeWord), commit())}><WholeWord /></button>
      <button type="button" class={toggle} aria-pressed={regexp} aria-label={t("mdx.regexp")} title={t("mdx.regexp")} onclick={() => ((regexp = !regexp), commit())}><Regex /></button>
    </div>
  </div>
</div>
