<script lang="ts">
  import { ChevronRight, Layers, ListChecks } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { ApiError } from "#lib/api.ts";
  import ConsentCard from "./ConsentCard.svelte";
  import ToolRow from "./ToolRow.svelte";
  import { latestPlan } from "#lib/agent/transcript.ts";
  import { cardKind } from "#lib/agent/tools.ts";
  import type { ToolCall } from "#lib/agent/types.ts";

  /**
   * Tool calls of one step: rows (consecutive finished reads grouped), then consent cards for pending calls. Plan
   * updates are one-line history rows here — the live checklist itself is rendered once per turn (PlanChecklist).
   * `bare` rows leave job chips, workflow cards and 復原 to the turn's result chips.
   */
  let { calls, compact = false, bare = false, indent = true, onDecide }: {
    calls: ToolCall[];
    compact?: boolean;
    bare?: boolean;
    /** Align with the assistant's avatar column (off inside the turn's expanded view). */
    indent?: boolean;
    onDecide: (call: ToolCall, decision: "approve" | "approve_conversation" | "deny", opts?: { reason?: string; editedArgs?: Record<string, unknown> }) => Promise<void>;
  } = $props();

  type Item = { kind: "row"; call: ToolCall } | { kind: "plan"; call: ToolCall } | { kind: "group"; calls: ToolCall[]; key: string };
  const items = $derived.by(() => {
    const out: Item[] = [];
    let reads: ToolCall[] = [];
    const flush = () => {
      if (reads.length >= 2) out.push({ kind: "group", calls: reads, key: reads[0]!.id });
      else for (const c of reads) out.push({ kind: "row", call: c });
      reads = [];
    };
    for (const c of calls) {
      if (c.status === "pending_approval" || c.status === "deferred") continue;
      // update_plan: a history row (「更新計畫（2/5）」).
      if (c.tool === "update_plan" && c.status === "done") {
        flush();
        out.push({ kind: "plan", call: c });
        continue;
      }
      // start_workflow carries the live workflow card: never folded into a read group.
      if (c.risk === "read" && c.status === "done" && !(c.result?.links?.length) && !["start_workflow", "start_goal", "update_goal"].includes(c.tool)) reads.push(c);
      else {
        flush();
        out.push({ kind: "row", call: c });
      }
    }
    flush();
    return out;
  });
  const pending = $derived(calls.filter((c) => c.status === "pending_approval" || c.status === "deferred"));
  const bulk = $derived(pending.filter((c) => cardKind(c) === "write" || cardKind(c) === "outbound"));
  let openGroups = $state<Record<string, boolean>>({});
  let bulkBusy = $state(false);

  async function all(decision: "approve" | "deny") {
    bulkBusy = true;
    try {
      // 「全部允許」 also covers the rest of the conversation for each tool + study (grantable writes), so the same kinds
      // of writes do not ask again; a call the grant already approved answers 409 and is skipped.
      for (const c of decision === "approve" ? bulk : pending) {
        try {
          await onDecide(c, decision === "approve" && c.grantable ? "approve_conversation" : decision);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e;
        }
      }
    } catch (e) {
      toasts.show(`${t("agent.consent.failed")}：${(e as Error).message}`, "error");
    } finally {
      bulkBusy = false;
    }
  }
</script>

{#if items.length}
  <ul class="{indent ? 'ml-11' : ''} flex flex-col">
    {#each items as item (item.kind === "group" ? item.key : item.call.id)}
      {#if item.kind === "plan"}
        {@const p = latestPlan([item.call])}
        <li class="flex min-h-9 items-center gap-2.5 px-1 text-[13px] text-ink-3">
          <span class="grid size-7 shrink-0 place-items-center rounded-full bg-surface-3"><ListChecks class="size-3.5" /></span>
          <span class="tabular-nums">{t("agent.plan.updateRow", { done: p?.done ?? 0, total: p?.total ?? 0 })}</span>
        </li>
      {:else if item.kind === "row"}
        <ToolRow call={item.call} {bare} />
      {:else}
        <li>
          <button type="button" class="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-1 text-left text-[13.5px] text-ink-2 hover:bg-surface-2" aria-expanded={!!openGroups[item.key]} onclick={() => (openGroups[item.key] = !openGroups[item.key])}>
            <span class="grid size-7 place-items-center rounded-full bg-surface-3"><Layers class="size-3.5" /></span>
            <span class="flex-1">{t("agent.tool.readGroup", { n: item.calls.length })}</span>
            <ChevronRight class="size-3.5 text-ink-3 transition-transform duration-150 {openGroups[item.key] ? 'rotate-90' : ''}" />
          </button>
          {#if openGroups[item.key]}
            <ul class="ml-3 border-l border-line pl-2">
              {#each item.calls as c (c.id)}<ToolRow call={c} nested {bare} />{/each}
            </ul>
          {/if}
        </li>
      {/if}
    {/each}
  </ul>
{/if}

{#if pending.length}
  <div class="flex flex-col gap-2.5 {compact || !indent ? '' : 'sm:ml-11'}">
    {#if pending.length > 1}
      <div class="flex flex-wrap items-center justify-between gap-2 px-1">
        <p class="text-[13px] font-medium text-ink-2">{t("agent.consent.several", { n: pending.length })}</p>
        <div class="flex gap-1.5">
          <Button size="sm" variant="ghost" disabled={bulkBusy} onclick={() => all("deny")}>{t("agent.consent.denyAll")}</Button>
          {#if bulk.length}<Button size="sm" variant="secondary" loading={bulkBusy} onclick={() => all("approve")}>{t("agent.consent.allowAll")}</Button>{/if}
        </div>
      </div>
    {/if}
    {#each pending as c (c.id)}
      <div data-focus-key="toolcall:{c.id}" class="rounded-[20px]"><ConsentCard call={c} {compact} onDecide={(d, o) => onDecide(c, d, o)} /></div>
    {/each}
  </div>
{/if}
