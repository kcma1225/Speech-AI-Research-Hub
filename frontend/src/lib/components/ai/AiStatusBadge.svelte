<script lang="ts">
  import { Popover } from "bits-ui";
  import { Search, Sparkles } from "@lucide/svelte";
  import { aiStatus, type AiRoleState } from "#lib/ai/status.svelte.ts";
  import { ROLE_KEYS, STATE_KEYS } from "#lib/ai/admin.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import StateDot from "./StateDot.svelte";

  /** Topbar AI status: a dot showing the worst role state, with a popover (sheet on phones) listing every role. */
  let open = $state(false);
  $effect(() => aiStatus.watch());

  const rank: Record<AiRoleState, number> = { ok: 0, unconfigured: 1, degraded: 2, unavailable: 3 };
  const configured = $derived(aiStatus.all.filter(r => r.status !== "unconfigured"));
  const worst = $derived<AiRoleState>(
    !aiStatus.loaded ? "unconfigured" : configured.length ? configured.reduce<AiRoleState>((w, r) => (rank[r.status] > rank[w] ? r.status : w), "ok") : "unconfigured",
  );
  const summary = $derived(
    worst === "ok" ? t(configured.length < aiStatus.all.length ? "aiStatus.configuredOk" : "aiStatus.allOk") : worst === "degraded" ? t("aiStatus.someDegraded") : worst === "unavailable" ? t("aiStatus.someDown") : t("aiStatus.noneConfigured"),
  );
  const label = $derived(t("aiStatus.label", { state: summary }));
</script>

{#snippet trigger(props: Record<string, unknown>)}
  <button
    {...props}
    type="button"
    aria-label={label}
    title={summary}
    class="relative grid size-10 place-items-center rounded-full border border-line bg-surface text-ink-2 transition-colors hover:text-ink data-[state=open]:border-ink-3 data-[state=open]:text-ink"
  >
    <Sparkles class="size-[18px]" />
    <span class="absolute top-1.5 right-1.5 grid place-items-center rounded-full border-2 border-surface"><StateDot state={worst} pulse /></span>
  </button>
{/snippet}

{#snippet body()}
  <p class="px-1 pb-2 text-[13px] text-ink-3">{summary}{#if worst === "unavailable" || worst === "degraded"} {t("aiStatus.othersFine")}{/if}</p>
  <ul class="divide-y divide-line/70">
    {#each aiStatus.all as r (r.role)}
      <li class="flex items-start gap-3 px-1 py-2.5">
        <StateDot state={r.status} class="mt-1.5" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <p class="truncate text-[14px] font-medium text-ink">{t(ROLE_KEYS[r.role].label)}</p>
            <span class="shrink-0 text-[12px] text-ink-3">{t(STATE_KEYS[r.status])}</span>
          </div>
          {#if r.status !== "ok" && r.message}<p class="mt-0.5 text-[12.5px] leading-snug text-ink-3">{r.message}</p>{/if}
        </div>
      </li>
    {/each}
  </ul>
  <div class="mt-2 flex items-center justify-between gap-2 border-t border-line px-1 pt-3">
    <span class="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3">
      <Search class="size-3.5" />{aiStatus.searchMode === "semantic" ? t("aiStatus.search.semantic") : t("aiStatus.search.keyword")}
    </span>
    {#if session.user?.is_admin}<Button size="sm" variant="ghost" href="/admin/models?tab=bindings" onclick={() => (open = false)}>{t("aiStatus.manage")}</Button>{/if}
  </div>
{/snippet}

{#if viewport.desktop}
  <Popover.Root bind:open>
    <Popover.Trigger>
      {#snippet child({ props })}{@render trigger(props)}{/snippet}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        align="end"
        sideOffset={10}
        class="z-50 w-[340px] rounded-[24px] border border-line bg-surface p-3 shadow-pop outline-none data-[state=open]:animate-[pop-in_140ms_ease-out]"
      >
        <p class="px-1 pb-1 text-[15px] font-semibold">{t("aiStatus.title")}</p>
        {@render body()}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  {@render trigger({ onclick: () => (open = true), "data-state": open ? "open" : "closed" })}
  <Sheet bind:open title={t("aiStatus.title")}>
    {@render body()}
  </Sheet>
{/if}
