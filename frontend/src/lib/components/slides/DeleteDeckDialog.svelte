<script lang="ts">
  import { goto } from "$app/navigation";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  /**
   * 「刪除簡報」 confirmation (study editors; the server checks too). With `studySlug` the page goes back to the study's
   * 簡報 tab afterwards; otherwise `onDeleted` decides (e.g. a list just reloads).
   */
  let { open = $bindable(false), deck, studySlug = null, onDeleted }: {
    open?: boolean;
    deck: { id: string; title: string } | null;
    studySlug?: string | null;
    onDeleted?: (id: string) => void | Promise<void>;
  } = $props();

  async function remove() {
    const target = deck;
    if (!target) return;
    try {
      await api.del(`/slides/${target.id}`);
    } catch (e) {
      toasts.show((e as Error).message, "error");
      throw e;
    }
    toasts.show(t("crud.deck.deleted", { title: target.title }), "success");
    await onDeleted?.(target.id);
    if (studySlug) await goto(`/studies/${encodeURIComponent(studySlug)}?tab=decks`, { replaceState: true });
  }
</script>

<ConfirmDialog
  bind:open
  title={t("crud.deck.deleteTitle", { title: deck?.title ?? "" })}
  description={t("crud.deck.deleteDescription")}
  confirmLabel={t("crud.deck.delete")}
  onConfirm={remove}
/>
