<script lang="ts">
  import { MessageCircleQuestion, Pencil, Sparkles } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import AskCard from "#lib/components/agent/AskCard.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import { answerLabel } from "#lib/agent/ask.ts";
  import type { Answer } from "#lib/agent/types.ts";
  import { workflowsApi } from "#lib/workflows/api.ts";
  import type { Workflow, WorkflowAsk } from "#lib/workflows/types.ts";

  /**
   * A workflow question card (backend `questions.ts`): pending → the `ask_user` AskCard (choices, 「其他」, skip,
   * review); answered → a compact summary with 「修改答案」 (re-opens the card; the workflow re-runs from there).
   * Fits the chat's compact layout (no fixed widths).
   */
  let { runId, ask, canEdit = true, onUpdated }: { runId: string; ask: WorkflowAsk; canEdit?: boolean; onUpdated?: (w: Workflow | null) => void } = $props();

  let editing = $state(false);
  const args = $derived({ intro: ask.intro, questions: ask.questions });
  const byId = $derived(new Map((ask.answers ?? []).map((a) => [a.id, a])));

  async function submit(answers: Answer[]) {
    const r = await workflowsApi.answer(runId, ask.id, answers);
    editing = false;
    onUpdated?.(r.workflow);
  }
</script>

<section class="mt-3 flex min-w-0 flex-col gap-2" aria-label={ask.title}>
  <div class="flex flex-wrap items-center gap-2">
    <MessageCircleQuestion class="size-4 shrink-0 text-ink-3" aria-hidden="true" />
    <p class="min-w-0 flex-1 text-[13px] font-semibold break-words text-ink">{ask.title}</p>
    {#if ask.pending}<Pill tone="butter">{t("wf.ask.waiting")}</Pill>{/if}
    {#if ask.ai_filled && !ask.pending}<Pill tone="butter"><Sparkles class="size-3" aria-hidden="true" />{t("wf.ask.aiFilled")}</Pill>{:else if ask.ai_suggested}<Pill tone="lilac"><Sparkles class="size-3" aria-hidden="true" />{t("wf.ask.aiOptions")}</Pill>{/if}
  </div>
  {#if ask.ai_filled && !ask.pending && !editing}<p class="text-[12.5px] leading-relaxed text-ink-3">{t("wf.ask.aiFilledHint")}</p>{/if}
  {#if ask.pending || editing}
    {#key `${ask.id}:${editing}:${ask.answered_at ?? ""}`}
      <AskCard {args} initial={ask.answers ?? []} {editing} onSubmit={submit} onCancel={editing ? () => (editing = false) : undefined} />
    {/key}
  {:else if ask.answers}
    <div class="rounded-2xl border border-line-2 bg-surface-2 p-3">
      <ol class="flex flex-col gap-2">
        {#each ask.questions as q (q.id)}
          <li class="min-w-0">
            <p class="text-[12.5px] text-ink-3 break-words">{q.prompt}</p>
            <p class="text-[13.5px] break-words whitespace-pre-line text-ink">{answerLabel(q, byId.get(q.id))}</p>
          </li>
        {/each}
      </ol>
      {#if canEdit}
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onclick={() => (editing = true)}><Pencil />{t("wf.ask.edit")}</Button>
          <span class="text-[12px] text-ink-3">{t("wf.ask.editHint")}</span>
        </div>
      {/if}
    </div>
  {/if}
</section>
