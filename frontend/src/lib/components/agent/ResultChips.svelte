<script lang="ts">
  import { ArrowUpRight, Undo2 } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import DraftJobChip from "./DraftJobChip.svelte";
  import { linkLabel, toolIcon, toolTitle } from "#lib/agent/tools.ts";
  import type { ToolCall } from "#lib/agent/types.ts";

  /**
   * What a turn produced, as compact chips under the answer: 「建立筆記〈…〉 · 開啟」 (hub links open in the document
   * viewer when the chat has one), 復原 for calls that ran without a card, and the live deck-draft job chip.
   */
  let { calls }: { calls: ToolCall[] } = $props();
  let undoing = $state<string | null>(null);
  let undoneLocal = $state<Record<string, boolean>>({});

  const draftOf = (c: ToolCall) => {
    const data = c.result?.data as { job_id?: unknown; deck?: { id?: unknown } } | null | undefined;
    return c.tool === "create_deck" && typeof data?.job_id === "string" && typeof data.deck?.id === "string" ? { jobId: data.job_id, deckId: data.deck.id } : null;
  };
  const labelOf = (c: ToolCall) => {
    const name = c.target?.label?.split(" · ").pop() ?? "";
    const base = c.summary || toolTitle(c);
    return name && !base.includes(name) ? `${base}〈${name}〉` : base;
  };
  async function undo(c: ToolCall) {
    undoing = c.id;
    try {
      await api.post(`/agent/tool-calls/${c.id}/undo`);
      undoneLocal[c.id] = true;
      toasts.show(t("agent.tool.undoDone"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      undoing = null;
    }
  }
</script>

{#if calls.length}
  <ul class="ml-11 flex flex-col gap-1.5" aria-label={t("agent.result.label")}>
    {#each calls as c (c.id)}
      {@const Icon = toolIcon(c.tool)}
      {@const link = c.result?.links?.[0]}
      {@const undone = c.undo === "done" || undoneLocal[c.id]}
      {@const draft = draftOf(c)}
      <li class="chip-in">
        <div class="flex flex-wrap items-center gap-1.5">
          {#if link}
            <a href={link.url} class="inline-flex min-h-10 max-w-full items-center gap-2 rounded-full border border-line bg-surface py-1 pr-3 pl-1.5 text-[13px] text-ink hover:border-line-2 hover:bg-surface-2" title={linkLabel(link)}>
              <span class="grid size-7 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2"><Icon class="size-3.5" /></span>
              <span class="min-w-0 truncate {undone ? 'text-ink-3 line-through' : ''}">{labelOf(c)}</span>
              <span class="hidden shrink-0 text-[12px] text-ink-3 sm:inline">· {linkLabel(link)}</span>
              <ArrowUpRight class="size-3.5 shrink-0 text-ink-3" />
            </a>
          {:else}
            <span class="inline-flex min-h-10 max-w-full items-center gap-2 rounded-full border border-line bg-surface py-1 pr-3 pl-1.5 text-[13px] text-ink">
              <span class="grid size-7 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2"><Icon class="size-3.5" /></span>
              <span class="min-w-0 truncate {undone ? 'text-ink-3 line-through' : ''}">{labelOf(c)}</span>
            </span>
          {/if}
          {#if undone}
            <span class="rounded-full bg-[var(--pill-butter)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--pill-butter-ink)]">{t("agent.tool.undone")}</span>
          {:else if c.undo === "available"}
            <button type="button" class="inline-flex min-h-10 items-center gap-1 rounded-full px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-50" title={t("agent.tool.undoTitle")} disabled={undoing === c.id} onclick={() => undo(c)}><Undo2 class="size-3.5" />{t("agent.tool.undo")}</button>
          {/if}
        </div>
        {#if draft}<div class="-ml-[38px]"><DraftJobChip deckId={draft.deckId} jobId={draft.jobId} /></div>{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .chip-in {
    animation: chip-in 180ms ease-out;
  }
  @keyframes chip-in {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chip-in {
      animation: none;
    }
  }
</style>
