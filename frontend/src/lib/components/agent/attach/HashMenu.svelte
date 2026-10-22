<script lang="ts">
  import { tick } from "svelte";
  import { Hash } from "@lucide/svelte";
  import { i18n, relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { activeHash, kindKeyword, mentionText, parseHash, replaceToken, suggestKinds, type RefKind } from "#lib/agent/hashref.ts";
  import KindIcon from "./KindIcon.svelte";
  import { lookupRefs, type RefItem } from "./api.ts";
  import type { AttachDraft } from "./state.svelte.ts";
  import { MAX_ATTACHMENTS } from "./types.ts";

  /**
   * 「#」 autocomplete of the composer (`lib/agent/hashref.ts`): kinds first, then items of the chosen kind (or of all
   * kinds for `#text`), the current study first. ↑↓ / Enter / Tab / Esc on the textarea, which keeps the focus
   * (`aria-activedescendant`); picking an item puts 〈title〉 in the text and a chip in the draft. Sits above the
   * composer (the parent is `relative`).
   */
  let { textarea, value = $bindable(""), draft, study = null, disabled = false }: {
    textarea: HTMLTextAreaElement | null;
    value?: string;
    draft: AttachDraft;
    /** Current study (slug or id): ranked first. */
    study?: string | null;
    disabled?: boolean;
  } = $props();

  const uid = $props.id();
  const listId = `hash-${uid}`;
  let caret = $state(-1);
  let focused = $state(false);
  let dismissed = $state(-1);
  let active = $state(0);
  let items = $state<RefItem[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let loadedKey = $state("");
  let listEl = $state<HTMLElement | null>(null);

  const token = $derived(!disabled && focused && caret >= 0 ? activeHash(value, caret) : null);
  const live = $derived(token && token.start !== dismissed ? token : null);
  const parsed = $derived(live ? parseHash(live.raw) : null);
  const kinds = $derived(parsed && !parsed.kind ? suggestKinds(parsed.kindText) : []);
  /** What to search: a kind (query may be empty), or all kinds for `#text` that is no kind (nor the start of one). */
  const search = $derived(parsed ? (parsed.kind ? { kind: parsed.kind, q: parsed.query } : parsed.query && !kinds.length ? { kind: null, q: parsed.query } : null) : null);
  const searchKey = $derived(search ? `${search.kind ?? "*"}\u0000${search.q}\u0000${study ?? ""}` : "");

  type Option = { type: "kind"; kind: RefKind } | { type: "item"; item: RefItem };
  const options = $derived<Option[]>([...kinds.map((kind) => ({ type: "kind" as const, kind })), ...(search && loadedKey === searchKey ? items.map((item) => ({ type: "item" as const, item })) : [])]);
  const open = $derived(!!live && (options.length > 0 || !!search));

  // Reset the highlight when the list changes.
  $effect(() => {
    void options.length;
    void searchKey;
    active = 0;
  });

  let seq = 0;
  $effect(() => {
    const s = search;
    const key = searchKey;
    if (!s) return;
    const mine = ++seq;
    loading = true;
    failed = false;
    const timer = setTimeout(async () => {
      try {
        const r = await lookupRefs({ kind: s.kind, q: s.q, study, limit: s.kind ? 12 : 8 });
        if (mine !== seq) return;
        items = r.items;
        loadedKey = key;
      } catch {
        if (mine === seq) failed = true;
      } finally {
        if (mine === seq) loading = false;
      }
    }, s.q ? 160 : 0);
    return () => clearTimeout(timer);
  });

  // ---------------------------------------------------------------- textarea wiring
  function sync() {
    if (!textarea) return;
    caret = textarea.selectionStart === textarea.selectionEnd ? (textarea.selectionStart ?? -1) : -1;
  }
  function onKey(e: KeyboardEvent) {
    if (!open || e.isComposing || e.keyCode === 229) return;
    const n = options.length;
    if (e.key === "ArrowDown" && n) active = (active + 1) % n;
    else if (e.key === "ArrowUp" && n) active = (active - 1 + n) % n;
    else if ((e.key === "Enter" || e.key === "Tab") && n && !e.shiftKey) choose(options[active]!);
    // Results still on their way: Enter waits instead of sending the half-typed reference.
    else if (e.key === "Enter" && !e.shiftKey && loading) return void e.preventDefault();
    else if (e.key === "Escape") dismissed = live!.start;
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  $effect(() => {
    const el = textarea;
    if (!el) return;
    const onFocus = () => ((focused = true), sync());
    const onBlur = () => (focused = false);
    const events = ["input", "keyup", "click", "select"] as const;
    events.forEach((ev) => el.addEventListener(ev, sync));
    el.addEventListener("keydown", onKey);
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", onBlur);
    if (document.activeElement === el) onFocus();
    return () => {
      events.forEach((ev) => el.removeEventListener(ev, sync));
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", onBlur);
    };
  });
  // The textarea announces the list while it is open (it keeps the focus; options are aria-activedescendant).
  const activeId = $derived(open && options.length ? `${listId}-${active}` : null);
  $effect(() => {
    const el = textarea;
    if (!el) return;
    el.setAttribute("aria-autocomplete", "list");
    el.setAttribute("aria-haspopup", "listbox");
    if (open) el.setAttribute("aria-controls", listId);
    else el.removeAttribute("aria-controls");
    if (activeId) el.setAttribute("aria-activedescendant", activeId);
    else el.removeAttribute("aria-activedescendant");
  });
  $effect(() => {
    if (!activeId || !listEl) return;
    listEl.querySelector(`#${CSS.escape(activeId)}`)?.scrollIntoView({ block: "nearest" });
  });

  async function setText(next: { text: string; caret: number }) {
    value = next.text;
    await tick();
    textarea?.focus();
    textarea?.setSelectionRange(next.caret, next.caret);
    caret = next.caret;
  }
  function choose(o: Option) {
    const tok = live;
    if (!tok) return;
    if (o.type === "kind") {
      void setText(replaceToken(value, tok, `#${kindKeyword(o.kind, i18n.locale === "en" ? "en" : "zh-TW")}`));
      return;
    }
    const it = o.item;
    if (!draft.has(it.kind, it.id) && draft.full) {
      toasts.show(t("attach.hash.full", { max: MAX_ATTACHMENTS }), "error");
      return;
    }
    draft.add({ kind: it.kind, id: it.id, title: it.title, study: it.study, url: it.url });
    announce = t("attach.hash.added", { kind: kindLabel(it.kind), title: it.title });
    void setText(replaceToken(value, tok, mentionText(it.title)));
  }
  let announce = $state("");

  const kindLabel = (k: RefKind) => t(`attach.kind.${k}` as MessageKey);
  const status = $derived(
    !open ? "" : loading && !options.length ? t("attach.hash.searching") : failed ? t("attach.hash.failed") : search && loadedKey === searchKey && !items.length && !kinds.length ? (search.kind ? t("attach.hash.empty", { kind: kindLabel(search.kind) }) : t("attach.hash.emptyAll")) : "",
  );
</script>

<span class="sr-only" aria-live="polite">{announce}</span>
{#if open}
  <div class="menu absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-2xl border border-line bg-popover shadow-pop" data-hash-menu>
    <div class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] text-ink-3">
      <Hash class="size-3.5" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">{search?.kind ? kindLabel(search.kind) : t("attach.hash.label")}</span>
      {#if loading}<Spinner class="size-3.5" />{/if}
      <span class="hidden sm:inline" aria-hidden="true">{t("attach.hash.keys")}</span>
    </div>
    <!-- Options are chosen with the pointer (pointerdown keeps the textarea focused) or the textarea's keys. -->
    <ul bind:this={listEl} id={listId} role="listbox" aria-label={t("attach.hash.label")} class="max-h-[min(320px,45dvh)] overflow-y-auto overscroll-contain p-1.5">
      {#each options as o, i (o.type === "kind" ? `k:${o.kind}` : `i:${o.item.kind}:${o.item.id}`)}
        {#if o.type === "item" && i === kinds.length && kinds.length}<li role="presentation" class="mx-2 my-1 border-t border-line"></li>{/if}
        <!-- svelte-ignore a11y_click_events_have_key_events (keys go through the textarea: aria-activedescendant) -->
        <li
          id="{listId}-{i}"
          role="option"
          aria-selected={i === active}
          class="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left aria-selected:bg-surface-2"
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => choose(o)}
          onpointermove={() => (active = i)}
        >
          {#if o.type === "kind"}
            <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2"><KindIcon kind={o.kind} class="size-3.5" /></span>
            <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">#{kindLabel(o.kind)}</span>
            <span class="shrink-0 truncate text-[11.5px] text-ink-3">{t(`attach.hash.kindHint.${o.kind}` as MessageKey)}</span>
          {:else}
            {@const it = o.item}
            <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2"><KindIcon kind={it.kind} class="size-3.5" /></span>
            <span class="flex min-w-0 flex-1 flex-col leading-tight">
              <span class="truncate text-[13.5px] font-medium text-ink">{it.title}</span>
              <span class="truncate text-[11.5px] text-ink-3">{[search?.kind ? null : kindLabel(it.kind), it.kind === "study" ? null : it.study?.title, it.date ? relativeTime(it.date) : null].filter(Boolean).join(" · ")}</span>
            </span>
            {#if it.here && it.kind !== "study"}<span class="shrink-0 rounded-full bg-[var(--pill-mint)] px-2 py-0.5 text-[11px] font-medium text-[var(--pill-mint-ink)]">{t("attach.hash.here")}</span>{/if}
          {/if}
        </li>
      {/each}
    </ul>
    {#if status}<p class="px-4 pt-1 pb-3 text-[12.5px] text-ink-3" role="status">{status}</p>{/if}
  </div>
{/if}

<style>
  .menu {
    animation: menu-in 120ms cubic-bezier(0.2, 0, 0, 1);
  }
  @keyframes menu-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .menu {
      animation: none;
    }
  }
</style>
