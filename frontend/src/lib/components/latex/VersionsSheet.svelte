<script lang="ts">
  import { displayName } from "#lib/people.svelte.ts";
  import { BookmarkPlus, History, RotateCcw } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { LatexVersion, ProjectDetail } from "#lib/latex/types.ts";

  /** Named snapshots of the whole project; restoring backs up the current state first. */
  let { open = $bindable(false), projectId, canEdit, onRestored }: { open?: boolean; projectId: string; canEdit: boolean; onRestored: (d: ProjectDetail) => void } = $props();

  let versions = $state<LatexVersion[] | null>(null);
  let label = $state("");
  let saving = $state(false);
  let restoring = $state<LatexVersion | null>(null);
  let confirmOpen = $state(false);

  async function load() {
    try {
      versions = (await api.get<{ versions: LatexVersion[] }>(`/latex/${projectId}/versions`)).versions;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  $effect(() => {
    if (open) void load();
  });
  async function save(event?: Event) {
    event?.preventDefault();
    saving = true;
    try {
      await api.post(`/latex/${projectId}/versions`, { label: label.trim() });
      label = "";
      toasts.show(t("latex.versions.saved"), "success");
      await load();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }
  async function restore() {
    if (!restoring) return;
    let r: ProjectDetail & { version: LatexVersion };
    try {
      r = await api.post<ProjectDetail & { version: LatexVersion }>(`/latex/${projectId}/versions/${restoring.id}/restore`);
    } catch (e) {
      toasts.show((e as Error).message, "error");
      throw e;
    }
    toasts.show(t("latex.versions.restored"), "success");
    onRestored(r);
    await load();
  }
  const name = (v: LatexVersion) => v.label || formatDate(v.created_at, { dateStyle: "medium", timeStyle: "short" } as Intl.DateTimeFormatOptions);
</script>

<Sheet bind:open side="right" dirty={label.trim() !== ""} title={t("latex.versions")} description={t("latex.versions.hint")}>
  {#if canEdit}
    <form class="mb-4 flex items-end gap-2" onsubmit={save}>
      <TextField label={t("latex.versions.label")} bind:value={label} maxlength={200} placeholder={t("latex.versions.placeholder")} class="min-w-0 flex-1" />
      <Button type="submit" variant="primary" loading={saving}><BookmarkPlus />{t("latex.versions.save")}</Button>
    </form>
  {/if}
  {#if !versions}
    <p class="text-[13px] text-ink-3">{t("common.loading")}</p>
  {:else if !versions.length}
    <p class="flex items-center gap-2 py-6 text-[13px] text-ink-3"><History class="size-4" />{t("latex.versions.empty")}</p>
  {:else}
    <ul class="flex flex-col gap-1.5" role="list">
      {#each versions as v (v.id)}
        <li class="flex items-center gap-3 rounded-2xl border border-line px-3 py-2.5">
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13.5px] font-medium text-ink">{name(v)}</p>
            <p class="text-[12px] text-ink-3">{t(`latex.versions.kind.${v.kind}` as MessageKey)} · {relativeTime(v.created_at)}{v.created_by_name ? ` · ${displayName(v.created_by_name)}` : ""} · {t("latex.fileCount", { n: v.file_count })}</p>
          </div>
          {#if canEdit}
            <Button size="sm" variant="ghost" onclick={() => { restoring = v; confirmOpen = true; }}><RotateCcw />{t("latex.versions.restore")}</Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Sheet>

<ConfirmDialog
  bind:open={confirmOpen}
  title={t("latex.versions.restoreTitle", { label: restoring ? name(restoring) : "" })}
  description={t("latex.versions.restoreBody")}
  confirmLabel={t("latex.versions.restore")}
  danger={false}
  onConfirm={restore}
/>
