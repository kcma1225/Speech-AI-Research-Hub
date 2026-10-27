<script lang="ts">
  import { goto } from "$app/navigation";
  import { FileCode2, Send } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { SlideVersion } from "#lib/slides/types.ts";

  /**
   * 「用這版建立新版本」: the deck's Quarto source becomes this version's files (POST /source/restore) — published right
   * away as the next version, or opened in the editor to change first. Unpublished edits of the source are replaced
   * (said in the dialog); every published version stays as it is.
   */
  let { open = $bindable(false), deckId, version, unpublished = false, editUrl, onDone }: {
    open?: boolean;
    deckId: string;
    version: SlideVersion | null;
    /** The source has edits newer than the last publish: they are replaced (not kept in any version). */
    unpublished?: boolean;
    editUrl: string;
    onDone?: (published: boolean) => void | Promise<void>;
  } = $props();
  let busy = $state<"publish" | "edit" | null>(null);

  async function restore(publish: boolean) {
    const v = version;
    if (!v) return;
    busy = publish ? "publish" : "edit";
    try {
      const r = await api.post<{ version?: number; skipped: string[] }>(`/slides/${deckId}/source/restore`, { versionId: v.id, publish });
      toasts.show(publish ? t("slides.restore.published", { from: v.version, n: r.version ?? "" }) : t("slides.restore.loaded", { from: v.version }), "success");
      if (r.skipped.length) toasts.show(t("slides.restore.skipped", { files: r.skipped.slice(0, 3).join("、") }));
      open = false;
      await onDone?.(publish);
      if (!publish) await goto(editUrl);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = null;
    }
  }
</script>

<Sheet
  bind:open
  guard={false}
  title={t("slides.restore.title", { n: version?.version ?? "" })}
  description={t("slides.restore.description", { n: version?.version ?? "" })}
  side="center"
>
  {#snippet children()}
    {#if unpublished}
      <p class="rounded-xl border px-3 py-2 text-[13px] leading-relaxed" style="border-color:var(--pill-butter-ink);background:var(--pill-butter);color:var(--pill-butter-ink)">{t("slides.restore.unpublishedWarning")}</p>
    {/if}
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
    <Button variant="secondary" loading={busy === "edit"} disabled={!!busy} onclick={() => restore(false)}><FileCode2 />{t("slides.restore.edit")}</Button>
    <Button variant="primary" loading={busy === "publish"} disabled={!!busy} onclick={() => restore(true)}><Send />{t("slides.restore.publish")}</Button>
  {/snippet}
</Sheet>
