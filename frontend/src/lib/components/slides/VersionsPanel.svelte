<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { ChevronDown, ChevronUp, CircleCheck, Download, Ellipsis, Eye, RotateCcw, Trash2, Upload } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import { jobsStore } from "#lib/stores/jobs.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import { menuContent, menuItem, menuSeparator } from "#lib/components/ui/menu.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { SlideVersion } from "#lib/slides/types.ts";
  import { isBusy, stripAnsi } from "#lib/slides/util.ts";
  import StatusPill from "./StatusPill.svelte";

  let { projectId, versions, canManage, previewId = $bindable(null), onUpload, onChanged }: {
    projectId: string;
    versions: SlideVersion[];
    canManage: boolean;
    previewId?: string | null;
    onUpload: () => void;
    onChanged: () => void | Promise<void>;
  } = $props();

  let openError = $state<string | null>(null);
  let confirmDelete = $state<SlideVersion | null>(null);
  let confirmOpen = $state(false);
  const latestId = $derived(versions[0]?.id);

  async function run(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      toasts.show(message, "success");
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  const activate = (v: SlideVersion) =>
    run(() => api.patch(`/slides/${projectId}/versions/${v.id}`, { active: true }), t("slides.versions.activated", { n: v.version })).then(() => {
      if (previewId === v.id) previewId = null;
    });
  const retry = () =>
    run(async () => {
      await api.post(`/slides/${projectId}/render`);
      void jobsStore.refresh();
    }, t("slides.versions.retried"));
  async function remove() {
    const v = confirmDelete;
    if (!v) return;
    await run(() => api.del(`/slides/${projectId}/versions/${v.id}`), t("slides.versions.deleted", { n: v.version }));
    if (previewId === v.id) previewId = null;
  }
</script>

<div class="flex flex-col gap-3">
  {#if canManage}
    <Button variant="secondary" class="w-full" onclick={onUpload}><Upload />{t("slides.versions.upload")}</Button>
  {/if}
  <ul class="flex flex-col gap-2.5">
    {#each versions as v (v.id)}
      {@const busy = isBusy(v.status)}
      <li class="rounded-2xl border p-3.5 transition-colors {previewId === v.id ? 'border-ink bg-surface-2' : v.is_active ? 'border-line-2' : 'border-line'}">
        <div class="flex items-start gap-3">
          <span class="grid h-9 min-w-9 shrink-0 place-items-center rounded-xl bg-surface-3 px-2 text-[13px] font-semibold tabular-nums">v{v.version}</span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              {#if v.is_active}
                <Pill tone="stone" size="sm"><CircleCheck class="size-3" />{t("slides.versions.active")}</Pill>
              {/if}
              {#if v.status !== "published" || !v.is_active}<StatusPill status={v.status} />{/if}
            </div>
            <div class="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
              {#if v.uploader_name}
                <Avatar name={v.uploader_name} size={18} class="ring-0" /><span class="min-w-0 truncate text-ink-2">{v.uploader_name}</span><span aria-hidden="true">·</span>
              {/if}
              <time class="shrink-0" datetime={v.created_at} title={formatDate(v.created_at, { dateStyle: "medium", timeStyle: "short" })}>{relativeTime(v.published_at ?? v.created_at)}</time>
            </div>
            <p class="mt-0.5 truncate text-[11.5px] text-ink-3" title={v.source_name}>{v.source_name} · {t("slides.versions.entry", { entry: v.entry_qmd })}</p>
          </div>
          {#if v.viewUrl || v.pdfUrl || canManage}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger class="-mr-1.5 -mt-1 grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("slides.versions.more")}>
                <Ellipsis class="size-4" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={4} class={menuContent}>
                  {#if v.viewUrl && !v.is_active}
                    <DropdownMenu.Item class={menuItem} onSelect={() => (previewId = v.id)}><Eye />{t("slides.versions.preview")}</DropdownMenu.Item>
                  {/if}
                  {#if v.pdfUrl}
                    <DropdownMenu.Item class={menuItem} onSelect={() => (location.href = v.pdfUrl!)}><Download />{t("slides.pdf")}</DropdownMenu.Item>
                  {/if}
                  {#if canManage}
                    {#if v.status === "published" && !v.is_active}
                      <DropdownMenu.Item class={menuItem} onSelect={() => activate(v)}><CircleCheck />{t("slides.versions.setActive")}</DropdownMenu.Item>
                    {/if}
                    {#if v.status === "failed" && v.id === latestId}
                      <DropdownMenu.Item class={menuItem} onSelect={retry}><RotateCcw />{t("slides.versions.retry")}</DropdownMenu.Item>
                    {/if}
                    {#if !v.is_active}
                      <DropdownMenu.Separator class={menuSeparator} />
                      <DropdownMenu.Item class="{menuItem} text-danger [&_svg]:text-danger" onSelect={() => ((confirmDelete = v), (confirmOpen = true))}><Trash2 />{t("slides.versions.delete")}</DropdownMenu.Item>
                    {/if}
                  {/if}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          {/if}
        </div>
        {#if busy}
          <div class="mt-3 flex flex-col gap-1.5">
            <div class="flex justify-between text-[12px] text-ink-3"><span>{v.stage ?? t("slides.status.queued")}</span><span class="tabular-nums">{v.progress}%</span></div>
            <Progress value={v.progress || null} />
          </div>
        {/if}
        {#if v.status === "failed" && v.error}
          <button type="button" class="mt-2.5 inline-flex items-center gap-1 text-[12px] font-medium text-danger hover:underline" onclick={() => (openError = openError === v.id ? null : v.id)}>
            {openError === v.id ? t("slides.versions.hideError") : t("slides.versions.showError")}
            {#if openError === v.id}<ChevronUp class="size-3.5" />{:else}<ChevronDown class="size-3.5" />{/if}
          </button>
          {#if openError === v.id}
            <pre class="mt-2 max-h-56 overflow-auto rounded-xl bg-surface-2 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-ink-2">{stripAnsi(v.error)}</pre>
          {/if}
          {#if canManage && v.id === latestId}
            <Button size="sm" variant="secondary" class="mt-2.5" onclick={retry}><RotateCcw />{t("slides.versions.retry")}</Button>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
</div>

<ConfirmDialog
  bind:open={confirmOpen}
  title={t("slides.versions.deleteTitle", { n: confirmDelete?.version ?? "" })}
  description={t("slides.versions.deleteDescription")}
  confirmLabel={t("slides.versions.delete")}
  onConfirm={remove}
/>
