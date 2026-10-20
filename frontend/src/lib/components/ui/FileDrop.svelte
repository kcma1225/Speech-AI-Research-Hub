<script lang="ts">
  import { FileUp, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";

  /** Custom drop zone (the native file input stays visually hidden but keyboard-reachable). */
  let { file = $bindable(null), accept, label, hint, maxBytes, onError }: {
    file?: File | null;
    accept: string;
    label: string;
    hint?: string;
    maxBytes?: number;
    onError?: (message: string) => void;
  } = $props();
  let over = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  const uid = $props.id();

  function take(list: FileList | null | undefined) {
    const next = list?.[0];
    if (!next) return;
    const ok = accept.split(",").some(a => (a.startsWith(".") ? next.name.toLowerCase().endsWith(a.trim().toLowerCase()) : next.type === a.trim()));
    if (!ok) return onError?.(t("upload.badType", { types: accept }));
    if (maxBytes && next.size > maxBytes) return onError?.(t("upload.tooLarge", { size: formatBytes(maxBytes) }));
    file = next;
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
      take(e.dataTransfer?.files);
    }}
  >
    <span class="grid size-11 place-items-center rounded-2xl bg-surface-3 text-ink-2"><FileUp class="size-5" /></span>
    <span class="text-sm font-medium text-ink">{label}</span>
    {#if hint}<span class="text-[12.5px] text-ink-3">{hint}</span>{/if}
    <input bind:this={input} id="fd-{uid}" type="file" {accept} class="sr-only" onchange={() => take(input?.files)} />
  </label>
{/if}
