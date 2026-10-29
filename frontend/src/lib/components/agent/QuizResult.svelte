<script lang="ts">
  import { Check, CircleHelp, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { quizAnswer } from "#lib/agent/ask.ts";
  import type { Answer, AskQuestion, QuizGraded } from "#lib/agent/types.ts";

  /**
   * An answered 小測驗 in the user's answer bubble: per item the option chosen with ✓ (correct), ? (guessed) or ✗ (wrong,
   * with the right option and why), from the server's grading (`answer.graded`). A short answer is shown as written
   * (the assistant gives feedback; it is not graded). No total score.
   */
  let { question, answer }: { question: AskQuestion; answer: Answer | undefined } = $props();
  const items = $derived(question.items ?? []);
  const given = $derived(quizAnswer(answer?.value));
  const graded = $derived(new Map((answer?.graded ?? []).map((g) => [g.id, g] as const)));
  const label = (itemId: string, v: string | null | undefined) => items.find((i) => i.id === itemId)?.options.find((o) => o.value === v)?.label ?? "";
  const tone: Record<QuizGraded["outcome"], string> = {
    correct: "bg-[var(--pill-mint)] text-[var(--pill-mint-ink)]",
    guessed: "bg-[var(--pill-butter)] text-[var(--pill-butter-ink)]",
    wrong: "bg-[var(--pill-rose)] text-[var(--pill-rose-ink)]",
    unanswered: "bg-surface-3 text-ink-3",
    short: "bg-surface-3 text-ink-2",
  };
</script>

{#if !answer || answer.skipped}
  <p class="text-[13.5px] text-ink-3 italic">{t("agent.quiz.skipped")}</p>
{:else}
  <ol class="flex flex-col gap-2.5 text-[13.5px]">
    {#each items as it, i (it.id)}
      {@const g = graded.get(it.id)}
      {@const a = given[it.id]}
      <li class="flex gap-2.5">
        <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full {tone[g?.outcome ?? 'unanswered']}" aria-label={t(`agent.quiz.outcome.${g?.outcome ?? "unanswered"}`)}>
          {#if g?.outcome === "correct"}<Check class="size-3" />{:else if g?.outcome === "wrong"}<X class="size-3" />{:else if g?.outcome === "guessed"}<CircleHelp class="size-3" />{:else}<span class="text-[10px] font-semibold tabular-nums">{i + 1}</span>{/if}
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-[12px] leading-snug text-ink-3">{it.prompt}</p>
          {#if it.format === "short"}
            <p class="mt-0.5 break-words whitespace-pre-wrap text-ink">{a?.text || t("agent.quiz.outcome.unanswered")}</p>
          {:else}
            <p class="mt-0.5 break-words {a?.choice ? 'text-ink' : 'text-ink-3 italic'}">
              {a?.choice ? `${a.choice.toUpperCase()}. ${label(it.id, a.choice)}` : t("agent.quiz.outcome.unanswered")}
              {#if a?.guess}<span class="text-[12px] text-ink-3"> · {t("agent.quiz.guess")}</span>{/if}
            </p>
            {#if g && g.outcome !== "correct" && g.correct}
              <p class="mt-1 text-[12.5px] leading-relaxed break-words text-ink-2">{t("agent.quiz.rightAnswer", { answer: `${g.correct.toUpperCase()}. ${label(it.id, g.correct)}` })}</p>
              {#if g.why}<p class="mt-0.5 text-[12.5px] leading-relaxed break-words text-ink-3">{g.why}</p>{/if}
            {/if}
          {/if}
        </div>
      </li>
    {/each}
  </ol>
{/if}
