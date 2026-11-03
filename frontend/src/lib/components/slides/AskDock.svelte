<script lang="ts">
  import { tick } from "svelte";
  import { ChevronDown, ChevronUp, Copy, Ear, Hand, Keyboard, LoaderCircle, Mic, MicOff, Send, Square, TriangleAlert } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { renderMarkdown } from "#lib/markdown.ts";
  import type { AskSession } from "#lib/slides/ask-session.svelte.ts";
  import type { ListenError } from "#lib/slides/listen.svelte.ts";
  import { iosOtherBrowser } from "#lib/slides/device.ts";

  /**
   * 「提問助手」 view on the phone remote, on the same screen as the speaker notes (the professor asks in the middle of
   * the talk). Phones: a one-row bar under the notes (mic, what is being heard, 回答這題, open) that opens upwards into
   * the answers when one arrives; wide screens (`wide`): a full column beside the notes, always open.
   */
  let { session, wide = false, open = $bindable(false), disabled = false }: { session: AskSession; wide?: boolean; open?: boolean; disabled?: boolean } = $props();

  const listener = $derived(session.listener);
  const expanded = $derived(wide || open);
  let typing = $state(false);
  let typed = $state("");
  let input = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLElement | null>(null);

  // The newest answer comes into view (newest first, so the list scrolls to its top).
  let seen = 0;
  $effect(() => {
    const newest = session.cards[0]?.id ?? 0;
    if (newest === seen) return;
    seen = newest;
    void tick().then(() => list?.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
  });

  async function toggleTyping() {
    typing = !typing;
    if (typing) {
      open = true;
      await tick();
      input?.focus();
    }
  }
  function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    typed = "";
    void session.answer(q);
  }

  const errorText = (e: ListenError) =>
    ({
      unsupported: t("ask.err.unsupported"),
      "not-allowed": t("ask.err.notAllowed"),
      "service-not-allowed": t("ask.err.service"),
      "audio-capture": t("ask.err.audio"),
      network: t("ask.err.network"),
      other: t("ask.err.other"),
    })[e];
  // iPhone Chrome / Firefox / in-app browsers cannot hear at all: say so before the first tap, not "no permission".
  const otherBrowser = iosOtherBrowser();
  const problem = $derived(
    otherBrowser && listener.error !== "network" ? t("ask.err.iosBrowser", { name: otherBrowser }) : listener.error ? errorText(listener.error) : !listener.supported ? t("ask.err.unsupported") : null,
  );
  let copied = $state(false);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      copied = true;
      setTimeout(() => (copied = false), 2500);
    } catch {
      prompt(t("ask.copyLink"), location.href);
    }
  }
  const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Seconds an answer has been on its way (a reasoning model can think a while before the first word).
  let now = $state(Date.now());
  $effect(() => {
    if (!session.cards.some((c) => c.status === "answering")) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const waited = (at: Date) => Math.max(0, Math.round((now - at.getTime()) / 1000));
  const lastHeard = $derived(listener.interim ? `${listener.interim}…` : (session.heard.at(-1)?.text ?? ""));
  const answering = $derived(session.cards.filter((c) => c.status === "answering").length);
</script>

<section class="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface {expanded ? 'h-full' : ''}" aria-label={t("remote.tabAsk")}>
  <!-- Bar: mic · heard · 回答這題 · open -->
  <div class="flex shrink-0 items-center gap-1.5 p-1.5">
    <button
      type="button"
      class="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-3 text-[14px] font-semibold disabled:opacity-40 {listener.listening ? 'bg-danger-soft text-danger' : 'bg-ink text-canvas'}"
      aria-pressed={listener.listening}
      {disabled}
      onclick={() => session.toggleListen()}
    >
      {#if listener.listening}<MicOff class="size-4" />{t("ask.stopShort")}{:else}<Mic class="size-4" />{t("ask.startShort")}{/if}
    </button>
    <button type="button" class="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-xl px-1.5 text-left" onclick={() => (open = !open)} aria-expanded={expanded} aria-live="polite">
      {#if session.checking || answering}
        <LoaderCircle class="size-4 shrink-0 animate-spin text-ink-3 motion-reduce:animate-none" />
      {:else}
        <Ear class="size-4 shrink-0 {listener.listening ? 'animate-pulse text-success motion-reduce:animate-none' : 'text-ink-3'}" />
      {/if}
      <span class="min-w-0 flex-1 truncate text-[13px] {problem ? 'text-danger' : listener.interim ? 'text-ink-3' : 'text-ink-2'}">
        {problem ? t("ask.problemShort") : lastHeard || (listener.listening ? t("ask.hearing") : t("ask.idleShort"))}
      </span>
    </button>
    <button type="button" class="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-xl border border-line bg-surface-2 px-2.5 text-[14px] font-semibold disabled:opacity-40" disabled={disabled || !session.canAnswerNow} onclick={() => ((open = true), session.answerNow())}>
      <Hand class="size-4" />{t("ask.answerShort")}
    </button>
    <button type="button" class="grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl text-ink-2 hover:bg-surface-3 {typing ? 'bg-surface-3' : ''}" aria-label={t("ask.typeHint")} aria-pressed={typing} onclick={toggleTyping}><Keyboard class="size-4" /></button>
    {#if !wide}
      <button type="button" class="relative grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl text-ink-2 hover:bg-surface-3" aria-label={open ? t("ask.collapse") : t("ask.expand")} aria-expanded={open} onclick={() => (open = !open)}>
        {#if open}<ChevronDown class="size-5" />{:else}<ChevronUp class="size-5" />{/if}
        {#if !open && session.cards.length}<span class="absolute top-0.5 right-0.5 grid min-w-4.5 place-items-center rounded-full bg-ink px-1 text-[10.5px] leading-4.5 text-canvas tabular-nums">{session.cards.length}</span>{/if}
      </button>
    {/if}
  </div>

  {#if typing}
    <form class="flex shrink-0 gap-2 px-1.5 pb-1.5" onsubmit={(e) => (e.preventDefault(), sendTyped())}>
      <input bind:this={input} bind:value={typed} class="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 text-[15px]" placeholder={t("ask.typeHint")} enterkeyhint="send" />
      <button type="submit" class="grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl bg-ink text-canvas disabled:opacity-40" aria-label={t("ask.send")} disabled={!typed.trim() || disabled}><Send class="size-4" /></button>
    </form>
  {/if}

  {#if expanded}
    <div bind:this={list} class="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain border-t border-line p-2.5">
      {#if problem}
        <div class="rounded-xl bg-danger-soft px-3 py-2 text-[12.5px] text-danger" role="alert">
          <p class="flex gap-2"><TriangleAlert class="mt-0.5 size-4 shrink-0" />{problem}</p>
          {#if otherBrowser}
            <button type="button" class="mt-2 inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-surface px-3 text-[13px] font-medium text-ink" onclick={copyLink}><Copy class="size-4" />{copied ? t("ask.copied") : t("ask.copyLink")}</button>
          {/if}
        </div>
      {/if}
      {#if session.autoNote}<p class="text-[12.5px] text-ink-3">{session.autoNote}</p>{/if}

      {#each session.cards as c (c.id)}
        <article class="rounded-xl border p-3 {c.status === 'answering' ? 'border-[var(--pill-sky-ink)]/40' : 'border-line'}">
          <header class="mb-1.5 flex items-start gap-2 text-[12px] text-ink-3">
            <span class="min-w-0 flex-1">{c.auto ? t("ask.heardAuto") : t("ask.heardManual")} · {clock(c.at)}<span class="mt-0.5 block text-[13px] text-ink-2">「{c.heard}」</span></span>
            {#if c.status === "answering"}
              <button type="button" class="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-3" onclick={() => c.ctl.abort()}><Square class="size-3.5" />{t("ask.cancel")}</button>
            {/if}
          </header>
          {#if c.text}
            <div class="speaker-notes text-[16px] leading-relaxed [overflow-wrap:anywhere] text-ink">{@html renderMarkdown(c.text)}</div>
          {:else if c.status === "answering"}
            <p class="flex items-center gap-2 text-[14px] text-ink-3"><LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" />{t("ask.thinking")}<span class="tabular-nums">{waited(c.at)}s</span></p>
          {/if}
          {#if c.error}<p class="mt-2 text-[12.5px] text-danger" role="alert">{c.error}</p>{/if}
        </article>
      {:else}
        <div class="rounded-xl bg-surface-2 px-3 py-2 text-[13px] leading-relaxed">
          {#each session.heard.slice(-3) as h (h.at)}<p class="text-ink-2">{h.text}</p>{/each}
          {#if listener.interim}<p class="text-ink-3">{listener.interim}…</p>{/if}
          {#if !session.heard.length && !listener.interim}<p class="text-ink-3">{t("ask.emptyHint")}</p>{/if}
        </div>
      {/each}

      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-[13px]">
        <label class="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2">
          <input type="checkbox" checked={session.auto} onchange={(e) => (session.auto = e.currentTarget.checked)} class="size-5 shrink-0 accent-[var(--ink)]" />
          <span class="min-w-0">{t("ask.auto")}</span>
        </label>
        <select value={session.lang} onchange={(e) => (session.lang = e.currentTarget.value)} class="min-h-10 rounded-xl border border-line bg-surface-2 px-2 text-[13px]" aria-label={t("ask.lang")}>
          <option value="zh-TW">中文</option>
          <option value="en-US">English</option>
        </select>
      </div>
    </div>
  {/if}
</section>
