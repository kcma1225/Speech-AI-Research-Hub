<script lang="ts">
  import { tick, untrack } from "svelte";
  import { Ear, Hand, LoaderCircle, Mic, MicOff, Send, Square, TriangleAlert } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import { renderMarkdown } from "#lib/markdown.ts";
  import { askDeck } from "#lib/slides/ask.ts";
  import { Listener, type ListenError } from "#lib/slides/listen.svelte.ts";

  /**
   * 「提問助手」 on the phone remote: the phone listens to the room (browser speech recognition), every utterance is
   * checked in automatic mode (is it a question for the presenter?) and answered from the deck and its paper
   * (lib/slides/ask.ts on the server); 「回答這題」 answers what was just said without the check; a typed question too.
   * Stays mounted while the slide tab is shown, so listening goes on; nothing is stored.
   */
  let { deckId, page, onanswer }: { deckId: string | null; page: number; onanswer?: () => void } = $props();

  type Card = { id: number; heard: string; status: "answering" | "done" | "error"; text: string; error?: string; auto: boolean; at: Date; ctl: AbortController };
  let cards = $state<Card[]>([]);
  let heard = $state<{ at: number; text: string }[]>([]);
  let typed = $state("");
  let nextId = 1;

  const read = (key: string, fallback: string) => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  };
  let auto = $state(read("hub-ask-auto", "1") === "1");
  let lang = $state(read("hub-ask-lang", "zh-TW"));
  $effect(() => {
    try {
      localStorage.setItem("hub-ask-auto", auto ? "1" : "0");
      localStorage.setItem("hub-ask-lang", lang);
    } catch {}
  });

  /** The room's recent words, oldest first (≤ 5000 chars), for the server's context. */
  const transcript = () => heard.map((h) => h.text).join("\n").slice(-5000);

  // ---- Automatic: one check at a time; utterances heard meanwhile are checked together next. ----
  let checking = $state(false);
  let pending: string[] = [];
  let suppress = false;
  async function check(text: string) {
    if (!deckId) return;
    checking = true;
    const ctl = new AbortController();
    let card: Card | null = null;
    try {
      await askDeck(
        deckId,
        { heard: text, transcript: transcript(), page, gate: true },
        {
          signal: ctl.signal,
          onQuestion: () => {
            card = addCard(text, true, ctl);
          },
          onDelta: (d) => card && append(card.id, d),
        },
      );
      if (card) finish((card as Card).id);
    } catch (e) {
      if (card) fail((card as Card).id, (e as Error).message);
      else if ((e as { status?: number }).status === 429) autoNote = (e as Error).message;
    } finally {
      checking = false;
      const next = pending.splice(0).join(" ");
      if (next && auto && listener.listening) void check(next);
    }
  }
  let autoNote = $state<string | null>(null);

  function onUtterance(text: string) {
    heard = [...heard, { at: Date.now(), text }].slice(-80);
    if (suppress || !auto || text.replace(/\s/g, "").length < 4) return;
    if (checking) pending.push(text);
    else void check(text);
  }
  const listener = new Listener(onUtterance, untrack(() => lang));
  $effect(() => {
    listener.lang = lang;
  });
  $effect(() => () => listener.stop());

  function toggleListen() {
    if (listener.listening) listener.stop();
    else {
      autoNote = null;
      listener.lang = lang;
      listener.start();
    }
  }

  // ---- Answers ----
  function addCard(text: string, isAuto: boolean, ctl: AbortController): Card {
    const card: Card = { id: nextId++, heard: text, status: "answering", text: "", auto: isAuto, at: new Date(), ctl };
    cards = [card, ...cards].slice(0, 30);
    // The newest answer comes into view (it sits under the controls).
    void tick().then(() => document.querySelector(`[data-ask-card="${card.id}"]`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
    try {
      navigator.vibrate?.([30, 40, 30]);
    } catch {}
    onanswer?.();
    return card;
  }
  const update = (id: number, f: (c: Card) => Partial<Card>) => (cards = cards.map((c) => (c.id === id ? { ...c, ...f(c) } : c)));
  const append = (id: number, d: string) => update(id, (c) => ({ text: c.text + d }));
  const finish = (id: number) => update(id, () => ({ status: "done" }));
  const fail = (id: number, error: string) => update(id, (c) => ({ status: c.text ? "done" : "error", error }));

  async function answer(text: string) {
    if (!deckId || !text.trim()) return;
    const ctl = new AbortController();
    const card = addCard(text.trim(), false, ctl);
    try {
      await askDeck(deckId, { heard: text.trim(), transcript: transcript(), page, gate: false }, { signal: ctl.signal, onDelta: (d) => append(card.id, d) });
      finish(card.id);
    } catch (e) {
      if ((e as Error).name === "AbortError") return finish(card.id);
      fail(card.id, (e as Error).message);
    }
  }
  /** 「回答這題」: what is being said now, else the last thing heard (with the one before when it was short). */
  function answerNow() {
    suppress = true;
    const now = listener.flush();
    suppress = false;
    if (now) return void answer(now);
    // Nothing being said: the last utterance, with the one before when it is only a fragment.
    const last = heard.at(-1);
    const prev = heard.at(-2);
    void answer(last && prev && last.text.length < 12 ? `${prev.text} ${last.text}` : (last?.text ?? ""));
  }
  function sendTyped() {
    const q = typed.trim();
    if (!q) return;
    typed = "";
    void answer(q);
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
  const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Seconds an answer has been on its way (a reasoning model can think a while before the first word).
  let now = $state(Date.now());
  $effect(() => {
    if (!cards.some((c) => c.status === "answering")) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const waited = (c: Card) => Math.max(0, Math.round((now - c.at.getTime()) / 1000));
</script>

<div class="flex min-h-0 flex-col gap-3">
  <!-- Listening controls -->
  <div class="rounded-2xl border border-line bg-surface p-3">
    <div class="flex items-center gap-2">
      <Button variant={listener.listening ? "danger" : "primary"} class="min-h-12 flex-1 text-[15px]" onclick={toggleListen} disabled={!deckId}>
        {#if listener.listening}<MicOff />{t("ask.stop")}{:else}<Mic />{t("ask.start")}{/if}
      </Button>
      <select bind:value={lang} class="min-h-12 rounded-xl border border-line bg-surface-2 px-2 text-[13.5px]" aria-label={t("ask.lang")}>
        <option value="zh-TW">中文</option>
        <option value="en-US">English</option>
      </select>
    </div>
    <label class="mt-2.5 flex min-h-10 cursor-pointer items-center gap-2.5 text-[13.5px]">
      <input type="checkbox" bind:checked={auto} class="size-5 accent-[var(--ink)]" />
      <span class="min-w-0 flex-1">{t("ask.auto")}<span class="block text-[12px] text-ink-3">{t("ask.autoHint")}</span></span>
      {#if checking}<LoaderCircle class="size-4 shrink-0 animate-spin text-ink-3 motion-reduce:animate-none" />{/if}
    </label>
    {#if listener.error}
      <p class="mt-2 flex gap-2 rounded-xl bg-danger-soft px-3 py-2 text-[12.5px] text-danger" role="alert"><TriangleAlert class="mt-0.5 size-4 shrink-0" />{errorText(listener.error)}</p>
    {:else if !listener.supported}
      <p class="mt-2 flex gap-2 rounded-xl bg-danger-soft px-3 py-2 text-[12.5px] text-danger" role="alert"><TriangleAlert class="mt-0.5 size-4 shrink-0" />{t("ask.err.unsupported")}</p>
    {/if}
    {#if autoNote}<p class="mt-2 text-[12.5px] text-ink-3">{autoNote}</p>{/if}

    <!-- What the phone hears -->
    <div class="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[13.5px] leading-relaxed" aria-live="polite">
      <p class="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-ink-3">
        <Ear class="size-3.5 {listener.listening ? 'animate-pulse text-success motion-reduce:animate-none' : ''}" />{listener.listening ? t("ask.hearing") : t("ask.idle")}
      </p>
      {#each heard.slice(-2) as h (h.at)}<p class="text-ink-2">{h.text}</p>{/each}
      {#if listener.interim}<p class="text-ink-3">{listener.interim}…</p>{/if}
      {#if !heard.length && !listener.interim}<p class="text-ink-3">{t("ask.nothing")}</p>{/if}
    </div>

    <Button variant="secondary" class="mt-3 min-h-12 w-full text-[15px]" disabled={!deckId || (!heard.length && !listener.interim)} onclick={answerNow}><Hand />{t("ask.answerNow")}</Button>
    <form class="mt-2 flex gap-2" onsubmit={(e) => (e.preventDefault(), sendTyped())}>
      <input bind:value={typed} class="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 text-[14px]" placeholder={t("ask.typeHint")} enterkeyhint="send" />
      <Button type="submit" size="icon" variant="secondary" class="size-11" aria-label={t("ask.send")} disabled={!typed.trim() || !deckId}><Send /></Button>
    </form>
  </div>

  <!-- Answers, newest first -->
  {#each cards as c (c.id)}
    <article data-ask-card={c.id} class="scroll-mt-3 rounded-2xl border bg-surface p-3.5 {c.status === 'answering' ? 'border-[var(--pill-sky-ink)]/40' : 'border-line'}">
      <header class="mb-2 flex items-start gap-2 text-[12px] text-ink-3">
        <span class="min-w-0 flex-1">{c.auto ? t("ask.heardAuto") : t("ask.heardManual")} · {clock(c.at)}<span class="mt-0.5 block text-[13px] text-ink-2">「{c.heard}」</span></span>
        {#if c.status === "answering"}
          <button type="button" class="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-3" onclick={() => c.ctl.abort()}><Square class="size-3.5" />{t("ask.cancel")}</button>
        {/if}
      </header>
      {#if c.text}
        <div class="speaker-notes text-[16px] leading-relaxed text-ink">{@html renderMarkdown(c.text)}</div>
      {:else if c.status === "answering"}
        <p class="flex items-center gap-2 text-[14px] text-ink-3"><LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" />{t("ask.thinking")}<span class="tabular-nums">{waited(c)}s</span></p>
      {/if}
      {#if c.error}<p class="mt-2 text-[12.5px] text-danger" role="alert">{c.error}</p>{/if}
    </article>
  {/each}
</div>
