<script lang="ts">
  import { Check, Copy } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { copyText } from "#lib/library/api.ts";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  let { citations }: { citations: { apa: string; ieee: string; bibtex: string } } = $props();
  let style = $state<"apa" | "ieee" | "bibtex">("apa");
  let copied = $state(false);
  const text = $derived(citations[style]);

  async function copy() {
    if (await copyText(text)) {
      copied = true;
      setTimeout(() => (copied = false), 1600);
    } else toasts.show(t("library.detail.copyFailed"), "error");
  }
</script>

<div class="flex flex-col gap-2.5">
  <div class="flex items-center justify-between gap-2">
    <Segmented bind:value={style} label={t("library.detail.cite")} options={[{ value: "apa", label: "APA" }, { value: "ieee", label: "IEEE" }, { value: "bibtex", label: "BibTeX" }]} />
    <button type="button" class="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" onclick={copy}>
      {#if copied}<Check class="size-4" />{t("library.detail.copied")}{:else}<Copy class="size-4" />{t("library.detail.copy")}{/if}
    </button>
  </div>
  {#if style === "bibtex"}
    <pre class="max-h-60 overflow-auto rounded-xl bg-surface-2 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-ink-2 select-all">{text}</pre>
  {:else}
    <p class="rounded-xl bg-surface-2 p-3 text-[13.5px] leading-relaxed break-words text-ink-2 select-all">{text}</p>
  {/if}
</div>
