<script lang="ts">
  import { ClipboardCheck, Send } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { quizAnswer } from "#lib/agent/ask.ts";
  import type { Answer, AskQuestion, QuizAnswer } from "#lib/agent/types.ts";

  /**
   * The end-of-paper 小測驗 (`ask_user` question of type `quiz`; items filled by the server without the answer keys,
   * backend agent/quiz.ts): per item the concept, the question, 3–4 options (or one short answer) and 「我是猜的」.
   * Not scored; the server grades on submit and the answer message shows ✓ / ✗ (QuizResult). 略過 skips the quiz.
   */
  let { question, initial = [], editing = false, deferred = false, disabled = false, onSubmit, onCancel }: {
    question: AskQuestion;
    initial?: Answer[];
    editing?: boolean;
    deferred?: boolean;
    disabled?: boolean;
    onSubmit: (answers: Answer[]) => Promise<void>;
    onCancel?: () => void;
  } = $props();

  const uid = $props.id();
  // svelte-ignore state_referenced_locally
  const items = question.items ?? [];
  // svelte-ignore state_referenced_locally
  const prev = quizAnswer(initial.find((a) => a.id === question.id)?.value);
  let answers = $state<QuizAnswer>(Object.fromEntries(items.map((it) => [it.id, { ...(prev[it.id] ?? {}) }])));
  // svelte-ignore state_referenced_locally
  let open = $state(!deferred);
  $effect(() => {
    if (!deferred) open = true;
  });
  let busy = $state(false);
  const done = (id: string) => !!(answers[id]?.choice || answers[id]?.text?.trim());
  const count = $derived(items.filter((it) => done(it.id)).length);

  async function send(answer: Answer) {
    busy = true;
    try {
      await onSubmit([answer]);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }
  function submit() {
    const value: QuizAnswer = {};
    for (const it of items) {
      const a = answers[it.id];
      if (it.format === "choice" && a?.choice) value[it.id] = { choice: a.choice, ...(a.guess ? { guess: true } : {}) };
      if (it.format === "short" && a?.text?.trim()) value[it.id] = { text: a.text.trim() };
    }
    return send(Object.keys(value).length ? { id: question.id, value: JSON.stringify(value) } : { id: question.id, skipped: true });
  }
  const pick = (id: string, v: string) => (answers[id] = { ...answers[id], choice: answers[id]?.choice === v ? undefined : v });
</script>

{#if !open}
  <div class="flex flex-wrap items-center gap-3 rounded-[20px] border border-line bg-raised px-4 py-3 text-[13.5px] text-ink-2">
    <ClipboardCheck class="size-4 shrink-0 text-ink-3" />
    <span class="min-w-0 flex-1">{t("agent.quiz.title")}</span>
    <Button size="sm" variant="secondary" onclick={() => (open = true)}>{t("agent.ask.resume")}</Button>
  </div>
{:else}
  <section class="quiz-card flex flex-col rounded-[22px] border border-line bg-raised text-ink shadow-[0_1px_0_var(--line),0_8px_24px_-16px_rgb(0_0_0/0.25)]" aria-labelledby="{uid}-title">
    <header class="flex items-start gap-2.5 px-4 pt-4 sm:px-5">
      <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-[var(--pill-lilac)] text-[var(--pill-lilac-ink)]" aria-hidden="true"><ClipboardCheck class="size-3.5" /></span>
      <div class="min-w-0 flex-1">
        <h3 id="{uid}-title" class="text-[15px] leading-snug font-semibold">{question.prompt || t("agent.quiz.title")}</h3>
        <p class="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{editing ? t("agent.ask.editTitle") : t("agent.quiz.hint")}</p>
      </div>
    </header>

    <ol class="flex flex-col divide-y divide-line px-4 py-1 sm:px-5">
      {#each items as it, i (it.id)}
        {@const a = answers[it.id]}
        <li class="flex flex-col gap-2.5 py-4">
          <p class="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
            <span class="font-semibold text-ink-2 tabular-nums">{i + 1}.</span>
            <span class="rounded-full bg-surface-3 px-2 py-0.5 font-medium text-ink-2">{it.term}</span>
            {#if it.level === "apply"}<span class="rounded-full bg-[var(--pill-sky)] px-2 py-0.5 font-medium text-[var(--pill-sky-ink)]">{t("agent.quiz.apply")}</span>{/if}
            {#if it.section}<span class="tabular-nums">· {t("agent.tutor.section", { section: it.section.replace(/^§\s*/, "") })}</span>{/if}
          </p>
          <p id="{uid}-{it.id}" class="text-[14.5px] leading-relaxed font-medium break-words">{it.prompt}</p>
          {#if it.format === "choice"}
            <div class="flex flex-col gap-1.5" role="radiogroup" aria-labelledby="{uid}-{it.id}">
              {#each it.options as o (o.value)}
                {@const on = a?.choice === o.value}
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  class="flex min-h-11 w-full items-start gap-2.5 rounded-2xl border px-3 py-2.5 text-left text-[14px] leading-snug transition-colors duration-150 motion-reduce:transition-none {on ? 'border-ink bg-surface-2' : 'border-line hover:border-line-2 hover:bg-surface-2'}"
                  onclick={() => pick(it.id, o.value)}
                >
                  <span class="grid size-6 shrink-0 place-items-center rounded-full border text-[12px] font-semibold uppercase {on ? 'border-ink bg-ink text-canvas' : 'border-line-2 text-ink-3'}">{o.value}</span>
                  <span class="min-w-0 flex-1 pt-0.5 break-words">{o.label}</span>
                </button>
              {/each}
            </div>
            {#if a?.choice}
              <label class="inline-flex min-h-9 w-fit cursor-pointer items-center gap-2 self-end rounded-full px-2 text-[12.5px] text-ink-3 hover:text-ink">
                <input type="checkbox" class="size-4 accent-[var(--ink)]" checked={!!a.guess} onchange={(e) => (answers[it.id] = { ...a, guess: e.currentTarget.checked })} />
                {t("agent.quiz.guess")}
              </label>
            {/if}
          {:else}
            <Textarea bind:value={() => a?.text ?? "", (v) => (answers[it.id] = { text: v })} rows={3} maxlength={1000} placeholder={t("agent.quiz.shortPlaceholder")} aria-labelledby="{uid}-{it.id}" />
          {/if}
        </li>
      {/each}
    </ol>

    <footer class="sticky bottom-0 z-[1] flex flex-wrap items-center gap-2 rounded-b-[22px] border-t border-line bg-raised/95 px-3 py-2.5 backdrop-blur sm:px-4">
      {#if editing && onCancel}<Button size="sm" variant="ghost" onclick={onCancel}>{t("action.cancel")}</Button>{/if}
      <Button size="sm" variant="ghost" disabled={disabled || busy} onclick={() => void send({ id: question.id, skipped: true })}>{t("agent.quiz.skip")}</Button>
      <span class="flex-1"></span>
      <span class="text-[12px] text-ink-3 tabular-nums" aria-live="polite">{t("agent.quiz.answered", { n: count, total: items.length })}</span>
      <Button size="sm" variant="primary" loading={busy} disabled={disabled || !count} onclick={() => void submit()}><Send />{editing ? t("agent.ask.update") : t("agent.quiz.submit")}</Button>
    </footer>
  </section>
{/if}

<style>
  .quiz-card {
    animation: quiz-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes quiz-in {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.99);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .quiz-card {
      animation: none;
    }
  }
</style>
