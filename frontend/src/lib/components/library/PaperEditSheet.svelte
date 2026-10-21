<script lang="ts">
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { draftOf, emptyDraft, recordOf } from "#lib/library/draft.ts";
  import type { PaperDetail } from "#lib/library/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import PaperForm, { type PaperDraft } from "./PaperForm.svelte";

  let { open = $bindable(false), paper, onSaved }: { open?: boolean; paper: PaperDetail; onSaved: (p: PaperDetail) => void } = $props();
  let draft = $state<PaperDraft>(emptyDraft());
  let errors = $state<Partial<Record<keyof PaperDraft, string>>>({});
  let busy = $state(false);
  $effect(() => {
    if (open) {
      draft = draftOf(paper.record);
      errors = {};
    }
  });

  async function save() {
    const r = recordOf(draft, paper.record);
    errors = r.errors;
    if (!r.record) return;
    busy = true;
    try {
      const res = await api.patch<{ paper: PaperDetail }>(`/library/papers/${paper.id}`, { record: r.record });
      toasts.show(t("library.form.saved"), "success");
      onSaved(res.paper);
      open = false;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }
</script>

<Sheet bind:open title={t("library.form.editTitle")} side="right">
  {#snippet children()}<PaperForm bind:draft {errors} />{/snippet}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
    <Button variant="primary" loading={busy} onclick={save}>{t("library.form.save")}</Button>
  {/snippet}
</Sheet>
