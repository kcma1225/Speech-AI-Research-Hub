<script lang="ts">
  import { AudioLines, Brain, Braces, Eye, Wrench } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { ModelProfile } from "#lib/ai/admin.ts";
  import { tokens } from "#lib/ai/routing.ts";

  /** Compact capability chips of a model profile (context · output · vision · tools · reasoning · JSON · dims). */
  let { model, class: cls = "", limit = true }: { model: Pick<ModelProfile, "fields"> & { audio?: ModelProfile["audio"] }; class?: string; limit?: boolean } = $props();
  const f = $derived(model.fields);
  const audio = $derived(f.capability === "chat" && (model.audio ? model.audio.audio : f.audio_input === true));
</script>

<span class="inline-flex flex-wrap items-center gap-1 {cls}">
  {#if limit && f.capability === "chat" && f.context_window}
    <span class="chip" title={t("aiAdmin.field.context_window")}>{tokens(f.context_window)}<span class="text-ink-3">{t("aiAdmin.badge.ctx")}</span></span>
  {/if}
  {#if limit && f.capability === "chat" && f.max_output_tokens}
    <span class="chip" title={t("aiAdmin.field.max_output_tokens")}>{tokens(f.max_output_tokens)}<span class="text-ink-3">{t("aiAdmin.badge.out")}</span></span>
  {/if}
  {#if f.capability === "embedding" && f.embedding_dims}
    <span class="chip" title={t("aiAdmin.field.embedding_dims")}>{f.embedding_dims}<span class="text-ink-3">d</span></span>
  {/if}
  {#if f.vision}<span class="chip icon" title={t("aiAdmin.field.vision")}><Eye class="size-3" aria-hidden="true" /><span class="sr-only">{t("aiAdmin.field.vision")}</span></span>{/if}
  {#if audio}<span class="chip icon" title={t("aiAdmin.field.audio_input")}><AudioLines class="size-3" aria-hidden="true" /><span class="sr-only">{t("aiAdmin.field.audio_input")}</span></span>{/if}
  {#if f.tools && f.capability === "chat"}<span class="chip icon" title={t("aiAdmin.field.tools")}><Wrench class="size-3" aria-hidden="true" /><span class="sr-only">{t("aiAdmin.field.tools")}</span></span>{/if}
  {#if f.reasoning}<span class="chip icon" title={t("aiAdmin.field.reasoning")}><Brain class="size-3" aria-hidden="true" /><span class="sr-only">{t("aiAdmin.field.reasoning")}</span></span>{/if}
  {#if f.json_schema}<span class="chip icon" title={t("aiAdmin.field.json_schema")}><Braces class="size-3" aria-hidden="true" /><span class="sr-only">{t("aiAdmin.field.json_schema")}</span></span>{/if}
</span>

<style>
  .chip {
    display: inline-flex;
    height: 18px;
    align-items: center;
    gap: 2px;
    border-radius: 6px;
    background: color-mix(in oklab, var(--surface-3) 85%, transparent);
    padding: 0 5px;
    font-size: 10.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ink-2);
  }
  .chip.icon {
    padding: 0 4px;
  }
</style>
