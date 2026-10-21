<script lang="ts">
  import { ChevronDown, CircleAlert } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import { slide } from "svelte/transition";
  import { t } from "#lib/i18n.svelte.ts";
  import type { AiErrorBody } from "#lib/ai/admin.ts";

  /** Explains an AI/admin failure: 發生什麼事 / 建議怎麼做 / 技術細節 (collapsed). */
  let { error, actions, compact = false, class: cls = "" }: { error: AiErrorBody; actions?: Snippet; compact?: boolean; class?: string } = $props();
  let open = $state(false);
  const uid = $props.id();
  const details = $derived(JSON.stringify({ code: error.code, ...(error.detail ? { detail: error.detail } : {}) }, null, 2));
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
</script>

<div role="alert" class="rounded-2xl border border-danger/25 bg-danger-soft/60 {compact ? 'p-3' : 'p-4'} text-[13.5px] text-ink {cls}">
  <div class="flex gap-3">
    <CircleAlert class="mt-0.5 size-4.5 shrink-0 text-danger" />
    <div class="min-w-0 flex-1 space-y-2">
      <div>
        <p class="text-[11.5px] font-semibold tracking-wide text-danger uppercase">{t("aiAdmin.err.what")}</p>
        <p class="mt-0.5 font-medium">{error.error}</p>
      </div>
      <div>
        <p class="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">{t("aiAdmin.err.how")}</p>
        <p class="mt-0.5 text-ink-2">{error.hint ?? t("aiAdmin.err.defaultHint")}</p>
      </div>
      {#if actions}<div class="flex flex-wrap gap-2 pt-1">{@render actions()}</div>{/if}
      <button
        type="button"
        class="-ml-1 inline-flex h-8 items-center gap-1 rounded-lg px-1 text-[12.5px] text-ink-3 hover:text-ink"
        aria-expanded={open}
        aria-controls="err-{uid}"
        onclick={() => (open = !open)}
      >
        <ChevronDown class="size-3.5 transition-transform {open ? 'rotate-180' : ''}" />{t("aiAdmin.err.tech")}
      </button>
      {#if open}
        <pre id="err-{uid}" transition:slide={{ duration: reduce ? 0 : 160 }} class="max-h-64 overflow-auto rounded-xl bg-surface p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-ink-2">{details}</pre>
      {/if}
    </div>
  </div>
</div>
