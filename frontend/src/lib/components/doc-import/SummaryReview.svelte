<script lang="ts">
  import { untrack } from "svelte";
  import { Sparkles } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { SuggestionReview } from "#lib/components/suggest/review.svelte.ts";
  import SuggestionPanel from "#lib/components/suggest/SuggestionPanel.svelte";

  /**
   * Pending `study_summary` suggestions (file import, assistant): a banner with the count and a sheet to accept or
   * reject them hunk by hunk. Accepting writes `studies.summary_md` on the server; `onApplied` reloads the study.
   * Call `show()` (bind:this) to open it right after creating a suggestion.
   */
  let { studyId, summary, onApplied }: { studyId: string; summary: string; onApplied: () => Promise<void> } = $props();

  let text = $state(untrack(() => summary));
  const review = new SuggestionReview({ targetType: "study_summary", targetId: untrack(() => studyId), getText: () => text, onError: m => toasts.show(m, "error") });
  let open = $state(false);

  $effect(() => {
    text = summary;
    review.recompute();
  });
  $effect(() => {
    void review.refresh();
    return () => review.destroy();
  });
  // After each decision: reload the study (new summary text), then the suggestions (fresh ranges).
  let wasBusy = false;
  $effect(() => {
    const busy = review.busy;
    if (wasBusy && !busy) void onApplied().then(() => review.refresh());
    wasBusy = busy;
  });

  const pending = $derived(review.live.filter(h => !h.stale).length);
  export async function show() {
    await review.refresh();
    open = true;
  }
</script>

{#if review.live.length}
  <div class="mb-3 flex flex-wrap items-center gap-2 rounded-2xl px-3.5 py-2.5 text-[13px]" style="background:var(--pill-butter);color:var(--pill-butter-ink)" role="status">
    <Sparkles class="size-4 shrink-0" />
    <span class="min-w-0 flex-1 font-medium">{t("summarySuggest.pending", { n: pending || review.live.length })}</span>
    <Button size="sm" variant="secondary" onclick={() => (open = true)}>{t("summarySuggest.review")}</Button>
  </div>
{/if}

<Sheet bind:open title={t("summarySuggest.title")} description={t("summarySuggest.hint")} side="right">
  <SuggestionPanel {review} />
  {#snippet footer()}
    <Button variant="primary" onclick={() => (open = false)}>{t("summarySuggest.close")}</Button>
  {/snippet}
</Sheet>
