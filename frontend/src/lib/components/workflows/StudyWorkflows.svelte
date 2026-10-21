<script lang="ts">
  import { ChevronRight, Workflow as WorkflowIcon } from "@lucide/svelte";
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Pill from "#lib/components/ui/Pill.svelte";
  import { workflowsApi } from "#lib/workflows/api.ts";
  import type { Workflow } from "#lib/workflows/types.ts";
  import { STATUS_TONE } from "./meta.ts";

  /** 「進行中的工作流程」 strip on the study overview: my active runs in this study (nothing when there are none). */
  let { study }: { study: string } = $props();
  let list = $state<Workflow[]>([]);
  $effect(() => {
    const s = study;
    workflowsApi.list({ active: true, study: s, limit: 5 }).then((r) => (list = r.workflows)).catch(() => (list = []));
  });
</script>

{#if list.length}
  <section class="rounded-[20px] border border-line bg-surface p-3 sm:p-4" aria-label={t("wf.studyStrip")}>
    <div class="mb-1.5 flex items-center justify-between gap-2">
      <p class="flex items-center gap-1.5 text-[13px] font-semibold text-ink"><WorkflowIcon class="size-4 text-ink-3" />{t("wf.studyStrip")}</p>
      <a href="/assistant/workflows" class="inline-flex min-h-10 items-center rounded-full px-2 text-[12.5px] text-ink-3 hover:text-ink">{t("wf.viewAll")}</a>
    </div>
    <ul class="flex flex-col">
      {#each list as w (w.id)}
        <li>
          <a href={w.conversation_id ? `/assistant/${w.conversation_id}?workflow=${w.id}` : `/assistant/workflows?id=${w.id}`} class="flex min-h-11 items-center gap-2 rounded-xl px-2 hover:bg-surface-2">
            <span class="min-w-0 flex-1 truncate text-[13.5px] text-ink">{w.title}<span class="text-ink-3"> · {i18n.locale === "en" ? w.playbook_title_en : w.playbook_title}</span></span>
            <Pill size="sm" tone={STATUS_TONE[w.status]}>{t(`wf.status.${w.status}` as MessageKey)}</Pill>
            <ChevronRight class="size-4 shrink-0 text-ink-3" />
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}
