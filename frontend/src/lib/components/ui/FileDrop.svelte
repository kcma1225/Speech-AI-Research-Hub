<script lang="ts">
  import type { Snippet } from "svelte";
  import { FileUp, FolderUp, X } from "@lucide/svelte";
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import { droppedFolder, pickedFolder, type Folder } from "#lib/slides/folder.ts";
  import { markFormDirty } from "./close-guard.svelte.ts";

  /**
   * Custom drop zone (the native file inputs stay visually hidden but keyboard-reachable).
   * With `onFolder`, a dropped or picked directory is handed over instead of a file.
   */
  let { file = $bindable(null), accept, label, hint, maxBytes, onError, onFolder, folderLabel, details }: {
    file?: File | null;
    accept: string;
    label: string;
    hint?: string;
    maxBytes?: number;
    onError?: (message: string) => void;
    onFolder?: (folder: Folder) => void;
    folderLabel?: string;
    /** Extra line under the chosen file's size (e.g. what kind of deck it is). */
    details?: Snippet;
  } = $props();
  let over = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  let folderInput = $state<HTMLInputElement | null>(null);
  const uid = $props.id();
  const markDirty = markFormDirty();

  async function drop(data: DataTransfer | null) {
    if (onFolder) {
      // webkitGetAsEntry must run synchronously inside the drop handler; droppedFolder does that first.
      const pending = droppedFolder(data);
      const files = data?.files;
      const folder = await pending.catch(() => null);
      if (folder) return markDirty(), onFolder(folder);
      return take(files);
    }
    take(data?.files);
  }

  function take(list: FileList | null | undefined) {
    const next = list?.[0];
    if (!next) return;
    const ok = accept.split(",").some(a => (a.startsWith(".") ? next.name.toLowerCase().endsWith(a.trim().toLowerCase()) : next.type === a.trim()));
    if (!ok) return onError?.(t("upload.badType", { types: accept.split(",").map(a => a.trim()).join(i18n.locale === "en" ? ", " : "、") }));
    if (maxBytes && next.size > maxBytes) return onError?.(t("upload.tooLarge", { size: formatBytes(maxBytes) }));
    file = next;
    markDirty();
  }
  export function formatBytes(n: number) {
    return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  }
</script>

{#if file}
  <div class="flex items-center gap-3 rounded-2xl border border-line bg-surface-2 p-3.5">
    <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-surface text-ink-2"><FileUp class="size-[18px]" /></span>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium">{file.name}</p>
      <p class="text-[12px] text-ink-3">{formatBytes(file.size)}</p>
      {@render details?.()}
    </div>
    <button type="button" class="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("upload.remove")} onclick={() => (file = null)}><X class="size-4" /></button>
  </div>
{:else}
  <label
    for="fd-{uid}"
    class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-9 text-center transition-colors has-[:focus-visible]:border-ink {over ? 'border-ink bg-surface-2' : 'border-line-2 hover:border-ink-3 hover:bg-surface-2/60'}"
    ondragover={e => {
      e.preventDefault();
      over = true;
    }}
    ondragleave={() => (over = false)}
    ondrop={e => {
      e.preventDefault();
      over = false;
      void drop(e.dataTransfer);
    }}
  >
    <span class="grid size-11 place-items-center rounded-2xl bg-surface-3 text-ink-2"><FileUp class="size-5" /></span>
    <span class="text-sm font-medium text-ink">{label}</span>
    {#if hint}<span class="text-[12.5px] text-ink-3">{hint}</span>{/if}
    <input bind:this={input} id="fd-{uid}" type="file" {accept} class="sr-only" onchange={() => take(input?.files)} />
  </label>
  {#if onFolder}
    <div class="-mt-1 flex justify-center">
      <button
        type="button"
        class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink [&_svg]:size-3.5"
        onclick={() => folderInput?.click()}
      >
        <FolderUp />{folderLabel ?? t("upload.folder")}
      </button>
      <input
        bind:this={folderInput}
        type="file"
        webkitdirectory
        multiple
        tabindex="-1"
        aria-hidden="true"
        class="sr-only"
        onchange={() => {
          const folder = pickedFolder(folderInput?.files ?? null);
          if (folder) onFolder(folder);
          if (folderInput) folderInput.value = "";
        }}
      />
    </div>
  {/if}
{/if}
