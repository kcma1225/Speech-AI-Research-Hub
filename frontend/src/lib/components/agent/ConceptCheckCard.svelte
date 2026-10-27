<script lang="ts">
  import { GraduationCap, Send, Zap } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { CONCEPT_DIRECT, conceptLevels } from "#lib/agent/ask.ts";
  import type { Answer, AskQuestion, ConceptLevel } from "#lib/agent/types.ts";

  /**
   * 「先確認先備知識」 card (`ask_user` question of type `concept_check`; rows filled by the server, backend
   * agent/tutor.ts): one row per prerequisite — term (zh / en), one-line gloss, section — answered 懂 / 有聽過 / 不懂;
   * rows the user marked before are pre-filled with a 「上次標記懂」 hint. 「全部都懂，直接講」 and 略過 are shortcuts.
   * Phone: each row stacks its three choices in a full-width row of 40px targets.
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
  const LEVELS: ConceptLevel[] = ["known", "heard", "unknown"];
  // svelte-ignore state_referenced_locally
  const rows = question.concepts ?? [];
  // svelte-ignore state_referenced_locally
  const prev = initial.find((a) => a.id === question.id);
  const fromInitial = prev && Array.isArray(prev.value) ? conceptLevels(prev.value) : null;
  let levels = $state<Record<string, ConceptLevel | null>>(Object.fromEntries(rows.map((r) => [r.key, fromInitial ? (fromInitial.get(r.key) ?? null) : (r.prefill ?? null)])));
  // svelte-ignore state_referenced_locally
  let open = $state(!deferred);
  $effect(() => {
    if (!deferred) open = true;
  });
  let busy = $state(false);
  const marked = $derived(rows.filter((r) => levels[r.key]).length);

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
  const submit = () => {
    const value = rows.filter((r) => levels[r.key]).map((r) => `${r.key}=${levels[r.key]}`);
    return send(value.length ? { id: question.id, value } : { id: question.id, skipped: true });
  };
  const tone: Record<ConceptLevel, string> = {
    known: "bg-[var(--pill-mint)] text-[var(--pill-mint-ink)] border-transparent",
    heard: "bg-[var(--pill-butter)] text-[var(--pill-butter-ink)] border-transparent",
    unknown: "bg-[var(--pill-rose)] text-[var(--pill-rose-ink)] border-transparent",
  };
</script>

{#if !open}
  <div class="flex flex-wrap items-center gap-3 rounded-[20px] border border-line bg-raised px-4 py-3 text-[13.5px] text-ink-2">
    <GraduationCap class="size-4 shrink-0 text-ink-3" />
    <span class="min-w-0 flex-1">{t("agent.tutor.cardTitle")}</span>
    <Button size="sm" variant="secondary" onclick={() => (open = true)}>{t("agent.ask.resume")}</Button>
  </div>
{:else}
  <section class="concept-card flex flex-col rounded-[22px] border border-line bg-raised text-ink shadow-[0_1px_0_var(--line),0_8px_24px_-16px_rgb(0_0_0/0.25)]" aria-labelledby="{uid}-title">
    <header class="flex items-start gap-2.5 px-4 pt-4 sm:px-5">
      <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-[var(--pill-sky)] text-[var(--pill-sky-ink)]" aria-hidden="true"><GraduationCap class="size-3.5" /></span>
      <div class="min-w-0 flex-1">
        <h3 id="{uid}-title" class="text-[15px] leading-snug font-semibold">{question.prompt || t("agent.tutor.cardTitle")}</h3>
        <p class="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{editing ? t("agent.ask.editTitle") : t("agent.tutor.cardHint")}</p>
      </div>
    </header>

    <ul class="flex flex-col divide-y divide-line px-4 py-2 sm:px-5">
      {#each rows as r (r.key)}
        {@const cur = levels[r.key]}
        <li class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
              <span class="text-[14.5px] font-semibold break-words">{r.term_zh || r.term_en}</span>
              {#if r.term_zh}<span class="text-[12.5px] break-words text-ink-3">{r.term_en}</span>{/if}
              {#if r.section}<span class="text-[11.5px] text-ink-3 tabular-nums">· {t("agent.tutor.section", { section: r.section.replace(/^§\s*/, "") })}</span>{/if}
              {#if r.centrality === "core"}<span class="rounded-full bg-surface-3 px-1.5 text-[10.5px] font-medium text-ink-2">{t("agent.tutor.core")}</span>{/if}
            </p>
            <p class="mt-0.5 text-[13px] leading-snug break-words text-ink-2">{r.gloss}</p>
            {#if r.remembered && r.prefill}<p class="mt-0.5 text-[11.5px] text-ink-3">{t("agent.tutor.remembered", { level: t(`agent.tutor.${r.prefill}`) })}</p>{/if}
          </div>
          <div class="grid shrink-0 grid-cols-3 gap-1 rounded-full border border-line bg-surface-2 p-1 sm:w-[228px]" role="radiogroup" aria-label={t("agent.tutor.levelFor", { term: r.term_zh || r.term_en })}>
            {#each LEVELS as lv (lv)}
              <button
                type="button"
                role="radio"
                aria-checked={cur === lv}
                class="h-9 rounded-full border px-2 text-[12.5px] font-medium whitespace-nowrap transition-colors duration-150 pointer-coarse:h-10 motion-reduce:transition-none {cur === lv ? tone[lv] : 'border-transparent text-ink-3 hover:bg-surface-3 hover:text-ink'}"
                onclick={() => (levels[r.key] = cur === lv ? null : lv)}
              >{t(`agent.tutor.${lv}`)}</button>
            {/each}
          </div>
        </li>
      {/each}
    </ul>

    <footer class="sticky bottom-0 z-[1] flex flex-wrap items-center gap-2 rounded-b-[22px] border-t border-line bg-raised/95 px-3 py-2.5 backdrop-blur sm:px-4">
      {#if editing && onCancel}<Button size="sm" variant="ghost" onclick={onCancel}>{t("action.cancel")}</Button>{/if}
      <Button size="sm" variant="secondary" disabled={disabled || busy} onclick={() => void send({ id: question.id, value: [CONCEPT_DIRECT] })}><Zap />{t("agent.tutor.allKnown")}</Button>
      <span class="flex-1"></span>
      <span class="text-[12px] text-ink-3 tabular-nums" aria-live="polite">{t("agent.tutor.progress", { n: marked, total: rows.length })}</span>
      <Button size="sm" variant="ghost" disabled={disabled || busy} onclick={() => void send({ id: question.id, skipped: true })}>{t("agent.tutor.skipCard")}</Button>
      <Button size="sm" variant="primary" loading={busy} disabled={disabled || !marked} onclick={() => void submit()}><Send />{editing ? t("agent.ask.update") : t("agent.tutor.submit")}</Button>
    </footer>
  </section>
{/if}

<style>
  .concept-card {
    animation: concept-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes concept-in {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.99);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .concept-card {
      animation: none;
    }
  }
</style>
