<script lang="ts">
  import type { Snippet } from "svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { Tone } from "#lib/components/ui/Pill.svelte";
  import { stateTone, type Health } from "#lib/ai/routing.ts";
  import type { MessageKey } from "#lib/messages.ts";

  /**
   * One LEGO brick: an account-coloured block with studs on top. The first stud is the health light
   * (green ok · amber degraded · red down · grey unknown/off), the order chip says where the brick sits in its group.
   */
  let {
    tone,
    title,
    subtitle,
    seq,
    seqTitle,
    health,
    dim = false,
    compact = false,
    mono = true,
    lifted = false,
    badges,
    trailing,
    class: cls = "",
  }: {
    tone: Tone;
    title: string;
    subtitle?: string;
    seq?: string;
    seqTitle?: string;
    health?: Health;
    dim?: boolean;
    compact?: boolean;
    mono?: boolean;
    lifted?: boolean;
    badges?: Snippet;
    trailing?: Snippet;
    class?: string;
  } = $props();
  const healthKey = $derived(health ? (`aiAdmin.health.${health}` as MessageKey) : null);
</script>

<div
  class="brick relative flex min-w-0 items-center gap-2.5 rounded-[12px] {compact ? 'min-h-10 px-2.5 py-1.5' : 'min-h-[52px] px-3 py-2'} {dim ? 'opacity-55' : ''} {lifted ? 'lifted' : ''} {cls}"
  style="--b: var(--pill-{tone}); --bi: var(--pill-{tone}-ink)"
>
  <span class="studs" aria-hidden="true">
    <span class="stud" style={health ? `background:${stateTone(health === "off" ? undefined : health)}` : ""}></span>
    <span class="stud"></span>
    {#if !compact}<span class="stud"></span>{/if}
  </span>
  {#if seq}
    <span class="grid h-6 min-w-6 shrink-0 place-items-center rounded-md bg-[var(--bi)] px-1 text-[11px] font-bold text-[var(--b)] tabular-nums" title={seqTitle}>{seq}</span>
  {/if}
  <span class="min-w-0 flex-1">
    <span class="block truncate {mono ? 'font-mono text-[12.5px]' : 'text-[13.5px]'} font-semibold text-[var(--bi)]" title={title}>{title}</span>
    {#if subtitle || badges}
      <span class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px]" style="color: color-mix(in oklab, var(--bi) 78%, transparent)">
        {#if subtitle}<span class="truncate">{subtitle}</span>{/if}
        {#if badges}{@render badges()}{/if}
      </span>
    {/if}
  </span>
  {#if healthKey}<span class="sr-only">{t(healthKey)}</span>{/if}
  {#if trailing}{@render trailing()}{/if}
</div>

<style>
  .brick {
    background: var(--b);
    box-shadow:
      inset 0 -3px 0 color-mix(in oklab, var(--bi) 16%, transparent),
      0 1px 0 color-mix(in oklab, var(--bi) 10%, transparent);
    margin-top: 5px;
    transition:
      transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1),
      box-shadow 160ms;
  }
  .brick.lifted {
    transform: translateY(-3px) rotate(-1deg);
    box-shadow:
      inset 0 -3px 0 color-mix(in oklab, var(--bi) 16%, transparent),
      var(--shadow-pop);
  }
  .studs {
    position: absolute;
    top: -5px;
    left: 12px;
    display: flex;
    gap: 7px;
  }
  .stud {
    width: 14px;
    height: 6px;
    border-radius: 4px 4px 1px 1px;
    background: color-mix(in oklab, var(--b) 80%, var(--bi) 20%);
  }
  @media (prefers-reduced-motion: reduce) {
    .brick {
      transition: none;
    }
    .brick.lifted {
      transform: none;
    }
  }
</style>
