<script lang="ts">
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import { prefersReducedMotion } from "svelte/motion";
  import { ArrowLeft, ArrowRight, Check, MessageCircleQuestion, Pencil, Send } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import DatePicker from "#lib/components/ui/DatePicker.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import ConceptCheckCard from "./ConceptCheckCard.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { answerLabel, answered, draftFrom, scaleSize, toAnswer, type Draft } from "#lib/agent/ask.ts";
  import type { Answer, AskArgs, AskQuestion } from "#lib/agent/types.ts";

  /**
   * `ask_user` question card (Claude Desktop style): one question per step with progress, option cards (radio /
   * checkbox look), 「其他」 free text, Back / Skip / Next, a review step before submitting. Keyboard: 1–9 pick an
   * option, Enter = next (Ctrl/⌘+Enter in long text), Shift+Tab on the first control = back.
   * `initial` + `editing` re-open an answered card (「修改答案」); `deferred` starts collapsed (「繼續回答」).
   */
  let { args, initial = [], editing = false, deferred = false, disabled = false, onSubmit, onCancel }: {
    args: AskArgs;
    initial?: Answer[];
    editing?: boolean;
    deferred?: boolean;
    disabled?: boolean;
    onSubmit: (answers: Answer[]) => Promise<void>;
    onCancel?: () => void;
  } = $props();

  const uid = $props.id();
  // svelte-ignore state_referenced_locally
  const questions: AskQuestion[] = args.questions;
  // 「先確認先備知識」: a concept_check card has only that question and its own layout.
  const conceptQ = questions.find((x) => x.type === "concept_check") ?? null;
  // svelte-ignore state_referenced_locally
  let drafts = $state<Draft[]>(questions.map((q) => draftFrom(q, initial.find((a) => a.id === q.id))));
  const multi = questions.length > 1;
  const total = multi ? questions.length + 1 : 1; // + review
  let step = $state(0);
  let dir = $state(1);
  let visited = $state(1);
  // svelte-ignore state_referenced_locally
  let open = $state(!deferred);
  // A deep link to this card (lib/agent/focus.ts) lifts `deferred` while it is mounted: open it.
  $effect(() => {
    if (!deferred) open = true;
  });
  let busy = $state(false);
  let body = $state<HTMLElement | null>(null);

  const reviewing = $derived(multi && step === questions.length);
  const q = $derived(reviewing ? null : questions[step]!);
  const d = $derived(reviewing ? null : drafts[step]!);
  const canNext = $derived(!q || !q.required || answered(q, d!));
  const missing = $derived(questions.filter((x, i) => x.required && !answered(x, drafts[i]!)));
  const answeredCount = $derived(questions.filter((x, i) => answered(x, drafts[i]!)).length);
  const duration = $derived(prefersReducedMotion.current ? 0 : 180);

  async function go(to: number, focus = true) {
    if (to < 0 || to >= total) return;
    dir = to > step ? 1 : -1;
    step = to;
    visited = Math.max(visited, to + 1);
    if (!focus) return;
    await tick();
    first()?.focus({ preventScroll: true });
  }
  function first(): HTMLElement | null {
    return body?.querySelector<HTMLElement>("[data-first], button:not([disabled]), input, textarea, [tabindex='0']") ?? null;
  }
  function next() {
    if (!canNext || busy) return;
    if (d) d.skipped = false;
    if (step === total - 1) void submit();
    else void go(step + 1);
  }
  function skip() {
    if (!q || q.required) return;
    drafts[step] = { ...drafts[step]!, skipped: true };
    if (step === total - 1) void submit();
    else void go(step + 1);
  }
  async function submit() {
    if (missing.length) {
      void go(questions.indexOf(missing[0]!));
      return;
    }
    busy = true;
    try {
      await onSubmit(questions.map((x, i) => toAnswer(x, drafts[i]!)));
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }

  function pick(value: string) {
    if (!q || !d) return;
    d.skipped = false;
    if (q.type === "multi_choice") {
      const list = Array.isArray(d.value) ? d.value : [];
      d.value = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    } else {
      d.value = d.value === value && !q.required ? null : value;
      d.otherOn = false;
    }
  }
  function toggleOther() {
    if (!q || !d) return;
    d.skipped = false;
    d.otherOn = !d.otherOn;
    if (q.type === "single_choice" && d.otherOn) d.value = null;
    if (d.otherOn) void tick().then(() => body?.querySelector<HTMLInputElement>("[data-other] input")?.focus());
  }
  type Opt = { value: string; label: string; description?: string };
  const opts = $derived.by((): Opt[] => {
    if (!q) return [];
    if (q.type === "yes_no") return [{ value: "yes", label: t("agent.ask.yes") }, { value: "no", label: t("agent.ask.no") }];
    if (q.type === "scale") return Array.from({ length: scaleSize(q) }, (_, i) => ({ value: String(i + 1), label: q.scale_labels?.[i] ?? String(i + 1) }));
    return q.options ?? [];
  });
  const selected = (o: Opt) => {
    if (!q || !d) return false;
    if (q.type === "multi_choice") return Array.isArray(d.value) && d.value.includes(o.value);
    if (q.type === "yes_no") return d.value === (o.value === "yes") && d.value !== null;
    if (q.type === "scale") return d.value === Number(o.value);
    return d.value === o.value;
  };
  function choose(o: Opt) {
    if (!q || !d) return;
    if (q.type === "yes_no") {
      d.skipped = false;
      d.value = o.value === "yes";
    } else if (q.type === "scale") {
      d.skipped = false;
      d.value = Number(o.value);
    } else pick(o.value);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    const el = e.target as HTMLElement;
    const typing = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "checkbox");
    if (e.key === "Tab" && e.shiftKey && step > 0 && el === first()) {
      e.preventDefault();
      void go(step - 1);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (el.tagName === "TEXTAREA" && !(e.ctrlKey || e.metaKey)) return;
      if (el.closest("[data-picker]")) return; // date picker handles its own keys
      e.preventDefault();
      next();
      return;
    }
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key) && opts.length) {
      const o = opts[Number(e.key) - 1];
      if (o) {
        e.preventDefault();
        choose(o);
      }
    }
  }
</script>

{#if conceptQ}
  <ConceptCheckCard question={conceptQ} {initial} {editing} {deferred} {disabled} {onSubmit} {onCancel} />
{:else if !open}
  <div class="flex flex-wrap items-center gap-3 rounded-[20px] border border-line bg-raised px-4 py-3 text-[13.5px] text-ink-2">
    <MessageCircleQuestion class="size-4 shrink-0 text-ink-3" />
    <span class="min-w-0 flex-1">{t("agent.ask.unanswered", { n: questions.length })}</span>
    <Button size="sm" variant="secondary" onclick={() => (open = true)}>{t("agent.ask.resume")}</Button>
  </div>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (keyboard shortcuts for the controls inside) -->
  <section
    class="ask-card relative flex flex-col rounded-[22px] border border-line bg-raised text-ink shadow-[0_1px_0_var(--line),0_8px_24px_-16px_rgb(0_0_0/0.25)]"
    aria-labelledby="{uid}-title"
    {onkeydown}
  >
    <header class="flex flex-col gap-2.5 px-4 pt-4 sm:px-5">
      <div class="flex items-start gap-2.5">
        <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-[var(--pill-lilac)] text-[var(--pill-lilac-ink)]" aria-hidden="true"><MessageCircleQuestion class="size-3.5" /></span>
        <h3 id="{uid}-title" class="min-w-0 flex-1 whitespace-pre-line text-[13.5px] leading-relaxed text-ink-2">{args.intro || (editing ? t("agent.ask.editTitle") : t("agent.ask.title"))}</h3>
        {#if multi}<span class="shrink-0 pt-1 text-[12px] font-medium text-ink-3 tabular-nums" aria-live="polite">{reviewing ? t("agent.ask.review") : `${step + 1} / ${questions.length}`}</span>{/if}
      </div>
      {#if multi}
        <ol class="flex gap-1" aria-label={t("agent.ask.progress")}>
          {#each questions as x, i (x.id)}
            <li class="flex-1">
              <button
                type="button"
                class="group flex h-6 w-full items-center disabled:cursor-default"
                disabled={i + 1 > visited && i !== step}
                aria-label={t("agent.ask.goto", { n: i + 1 })}
                aria-current={i === step ? "step" : undefined}
                onclick={() => go(i)}
              >
                <span class="h-1.5 w-full rounded-full transition-colors duration-200 motion-reduce:transition-none {i === step ? 'bg-ink' : answered(x, drafts[i]!) ? 'bg-ink-3' : drafts[i]!.skipped ? 'bg-line-2' : 'bg-surface-3'}"></span>
              </button>
            </li>
          {/each}
        </ol>
      {/if}
    </header>

    <div class="relative overflow-hidden px-4 py-4 sm:px-5" bind:this={body}>
      {#key step}
        <div in:fly={{ x: dir * 18, duration, opacity: 0 }}>
          {#if q && d}
            <fieldset class="flex flex-col gap-3">
              <legend class="mb-3 text-[15.5px] leading-snug font-semibold text-ink">
                {q.prompt}
                {#if !q.required}<span class="ml-1.5 align-middle text-[11.5px] font-normal text-ink-3">{t("agent.ask.optional")}</span>{/if}
              </legend>
              {#if q.type === "single_choice" || q.type === "multi_choice" || q.type === "yes_no"}
                <div class="grid gap-2 {q.type === 'yes_no' ? 'grid-cols-2' : 'grid-cols-1'}" role={q.type === "multi_choice" ? "group" : "radiogroup"} aria-label={q.prompt}>
                  {#each opts as o, i (o.value)}
                    {@const on = selected(o)}
                    <button
                      type="button"
                      role={q.type === "multi_choice" ? "checkbox" : "radio"}
                      aria-checked={on}
                      data-first={i === 0 ? "" : undefined}
                      class="opt flex min-h-12 w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-[background-color,border-color,transform] duration-150 active:scale-[0.99] motion-reduce:transition-none {on ? 'border-ink bg-surface-2' : 'border-line hover:border-line-2 hover:bg-surface-2'}"
                      onclick={() => choose(o)}
                    >
                      <span class="grid size-5 shrink-0 place-items-center border-[1.5px] {q.type === 'multi_choice' ? 'rounded-md' : 'rounded-full'} {on ? 'border-ink bg-ink text-surface' : 'border-line-2 text-transparent'}" aria-hidden="true">
                        {#if q.type === "multi_choice"}<Check class="size-3" strokeWidth={3} />{:else}<span class="size-2 rounded-full {on ? 'bg-surface' : ''}"></span>{/if}
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="text-[14px] leading-snug font-medium">{o.label}</span>
                        {#if o.description}<span class="mt-0.5 text-[12.5px] leading-snug text-ink-3">{o.description}</span>{/if}
                      </span>
                      {#if i < 9}<kbd class="hidden size-5 shrink-0 place-items-center rounded-md border border-line-2 bg-surface-2 font-sans text-[11px] text-ink-3 [@media(pointer:fine)]:grid" aria-hidden="true">{i + 1}</kbd>{/if}
                    </button>
                  {/each}
                  {#if q.allow_other && q.type !== "yes_no"}
                    <button
                      type="button"
                      role={q.type === "multi_choice" ? "checkbox" : "radio"}
                      aria-checked={d.otherOn}
                      class="opt flex min-h-12 w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition-colors duration-150 motion-reduce:transition-none {d.otherOn ? 'border-ink bg-surface-2' : 'border-dashed border-line-2 hover:bg-surface-2'}"
                      onclick={toggleOther}
                    >
                      <span class="grid size-5 shrink-0 place-items-center border-[1.5px] {q.type === 'multi_choice' ? 'rounded-md' : 'rounded-full'} {d.otherOn ? 'border-ink bg-ink text-surface' : 'border-line-2 text-transparent'}" aria-hidden="true"><Pencil class="size-2.5" /></span>
                      <span class="text-[14px] font-medium">{t("agent.ask.otherOption")}</span>
                    </button>
                    {#if d.otherOn}
                      <div data-other transition:fly={{ y: -4, duration }}>
                        <TextField bind:value={d.other} maxlength={500} aria-label={t("agent.ask.otherOption")} placeholder={t("agent.ask.otherPlaceholder")} />
                      </div>
                    {/if}
                  {/if}
                </div>
              {:else if q.type === "scale"}
                <div class="flex flex-col gap-2">
                  <div class="grid gap-1.5" style="grid-template-columns: repeat({opts.length}, minmax(0, 1fr))" role="radiogroup" aria-label={q.prompt}>
                    {#each opts as o, i (o.value)}
                      {@const on = selected(o)}
                      <button type="button" role="radio" aria-checked={on} data-first={i === 0 ? "" : undefined} aria-label={o.label}
                        class="grid min-h-12 place-items-center rounded-2xl border px-1 text-[14px] font-semibold tabular-nums transition-colors duration-150 motion-reduce:transition-none {on ? 'border-ink bg-ink text-primary-ink' : 'border-line hover:bg-surface-2'}"
                        onclick={() => choose(o)}>{q.scale_labels ? i + 1 : o.label}</button>
                    {/each}
                  </div>
                  <div class="flex justify-between gap-3 text-[12px] text-ink-3"><span>{q.scale_labels?.[0] ?? t("agent.ask.scaleLow")}</span><span class="text-right">{q.scale_labels?.at(-1) ?? t("agent.ask.scaleHigh")}</span></div>
                  {#if q.scale_labels && typeof d.value === "number"}<p class="text-center text-[13px] text-ink-2">{q.scale_labels[d.value - 1]}</p>{/if}
                </div>
              {:else if q.type === "long_text"}
                <Textarea bind:value={() => (typeof d.value === "string" ? d.value : ""), (v) => ((d.value = v), (d.skipped = false))} rows={4} maxlength={5000} placeholder={q.placeholder} aria-label={q.prompt} data-first="" />
                <p class="text-[11.5px] text-ink-3 [@media(pointer:coarse)]:hidden">{t("agent.ask.ctrlEnter")}</p>
              {:else if q.type === "date"}
                <div data-picker>
                  <DatePicker bind:value={() => (typeof d.value === "string" ? d.value : ""), (v) => ((d.value = v || null), (d.skipped = false))} label={q.prompt} clearable placeholder={q.placeholder ?? t("agent.ask.pickDate")} />
                </div>
              {:else}
                <TextField
                  type={q.type === "number" ? "number" : "text"}
                  inputmode={q.type === "number" ? "decimal" : undefined}
                  bind:value={() => (d.value === null || d.value === undefined ? "" : String(d.value)), (v) => ((d.value = v), (d.skipped = false))}
                  maxlength={500}
                  placeholder={q.placeholder}
                  aria-label={q.prompt}
                  data-first=""
                />
              {/if}
            </fieldset>
          {:else}
            <div class="flex flex-col gap-2">
              <p class="mb-1 text-[15.5px] font-semibold">{t("agent.ask.reviewTitle")}</p>
              <ul class="flex flex-col divide-y divide-line rounded-2xl border border-line">
                {#each questions as x, i (x.id)}
                  <li class="flex items-start gap-3 px-3.5 py-2.5">
                    <div class="min-w-0 flex-1">
                      <p class="text-[12.5px] text-ink-3">{x.prompt}{#if x.required}<span class="text-danger"> *</span>{/if}</p>
                      <p class="mt-0.5 text-[14px] break-words {answered(x, drafts[i]!) ? 'text-ink' : 'text-ink-3 italic'}">{answered(x, drafts[i]!) ? answerLabel(x, toAnswer(x, drafts[i]!)) : t("agent.ask.skipped")}</p>
                    </div>
                    <button type="button" data-first={i === 0 ? "" : undefined} class="-mr-1.5 grid size-10 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("agent.ask.changeOne", { n: i + 1 })} onclick={() => go(i)}><Pencil class="size-3.5" /></button>
                  </li>
                {/each}
              </ul>
              {#if missing.length}<p class="text-[12.5px] text-danger" role="alert">{t("agent.ask.missing", { n: missing.length })}</p>{/if}
            </div>
          {/if}
        </div>
      {/key}
    </div>

    <footer class="sticky bottom-0 z-[1] flex items-center gap-2 rounded-b-[22px] border-t border-line bg-raised/95 px-3 py-2.5 backdrop-blur sm:px-4">
      {#if step > 0}
        <Button size="sm" variant="ghost" onclick={() => go(step - 1)} aria-label={t("agent.ask.back")}><ArrowLeft />{t("agent.ask.back")}</Button>
      {:else if editing && onCancel}
        <Button size="sm" variant="ghost" onclick={onCancel}>{t("action.cancel")}</Button>
      {/if}
      <span class="flex-1"></span>
      {#if multi && !reviewing}<span class="hidden text-[12px] text-ink-3 tabular-nums sm:inline">{t("agent.ask.answeredCount", { n: answeredCount, total: questions.length })}</span>{/if}
      {#if q && !q.required && !answered(q, d!)}
        <Button size="sm" variant="ghost" onclick={skip}>{t("agent.ask.skip")}</Button>
      {/if}
      {#if step === total - 1}
        <Button size="sm" variant="primary" loading={busy} disabled={disabled || !canNext || missing.length > 0} onclick={() => void submit()}><Send />{editing ? t("agent.ask.update") : t("agent.ask.submit")}</Button>
      {:else}
        <Button size="sm" variant="primary" disabled={!canNext} onclick={next}>{step === questions.length - 1 ? t("agent.ask.toReview") : t("agent.ask.next")}<ArrowRight /></Button>
      {/if}
    </footer>
  </section>
{/if}

<style>
  .ask-card {
    animation: ask-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes ask-in {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.99);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ask-card {
      animation: none;
    }
  }
</style>
