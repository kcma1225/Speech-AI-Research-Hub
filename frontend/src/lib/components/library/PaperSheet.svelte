<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import PaperDetailBody from "./PaperDetailBody.svelte";

  /** Side panel with a paper's details (and, inside a study, its reading data and notes). */
  let { open = $bindable(false), paperId, study = null, onChanged, tagSuggestions = [] }: {
    open?: boolean;
    paperId: string | null;
    study?: { id: string; slug: string; title: string; canEdit: boolean } | null;
    onChanged?: () => void;
    tagSuggestions?: string[];
  } = $props();
</script>

<Sheet bind:open title={t("library.detail.title")} side="right">
  {#snippet children()}
    {#if paperId}
      <div class="pt-1"><PaperDetailBody {paperId} {study} {onChanged} {tagSuggestions} onGone={() => (open = false)} /></div>
    {/if}
  {/snippet}
</Sheet>
