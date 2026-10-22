<script lang="ts">
  import { page } from "$app/state";
  import { Tooltip } from "bits-ui";
  import type { Snippet } from "svelte";
  import { ArrowUpRight, PanelLeftClose, PanelLeftOpen } from "@lucide/svelte";
  import { canSee, isActive, manageNav, workspaceNav, type NavItem } from "#lib/nav.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { isSidebarShortcut, sidebar } from "#lib/stores/sidebar.svelte.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Kbd from "#lib/components/ui/Kbd.svelte";
  import Wordmark from "./Wordmark.svelte";
  import JobsWidget from "./JobsWidget.svelte";
  import JobsRail from "./JobsRail.svelte";

  const visible = (item: NavItem) => canSee(item, session.user);
  const collapsed = $derived(sidebar.collapsed);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const toggleLabel = $derived(collapsed ? t("nav.expand") : t("nav.collapse"));

  // Width, padding and label motion share one curve so the rail and the content settle together.
  const ease = "duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)]";
  const fade = $derived(`whitespace-nowrap transition-[opacity,translate] ${ease} ${collapsed ? "pointer-events-none -translate-x-1.5 opacity-0" : ""}`);

  function onKeydown(e: KeyboardEvent) {
    if (!viewport.desktop || !isSidebarShortcut(e)) return;
    e.preventDefault();
    sidebar.toggle();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Collapsed rail: each item explains itself in a tooltip (hover or keyboard focus). -->
{#snippet tip(text: string, trigger: Snippet<[Record<string, unknown>]>)}
  <Tooltip.Root disabled={!collapsed} delayDuration={150}>
    <Tooltip.Trigger>
      {#snippet child({ props })}{@render trigger(props)}{/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content
        side="right"
        sideOffset={14}
        class="z-50 flex items-center gap-2 rounded-[10px] bg-primary px-2.5 py-1.5 text-[12.5px] font-medium text-primary-ink shadow-pop data-[state=delayed-open]:animate-[fade-in_120ms_ease-out] data-[state=instant-open]:animate-[fade-in_120ms_ease-out]"
      >
        {text}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
{/snippet}

{#snippet link(item: NavItem)}
  {@const active = !item.external && isActive(item.href, page.url.pathname)}
  {#snippet anchor(props: Record<string, unknown>)}
    <a
      {...props}
      href={item.href}
      target={item.external ? "_blank" : undefined}
      rel={item.external ? "noopener noreferrer" : undefined}
      aria-current={active ? "page" : undefined}
      class="group flex h-10 items-center gap-3 overflow-hidden rounded-full text-[14px] font-medium transition-[padding,background-color,color,box-shadow] {ease} {collapsed
        ? 'px-[11px]'
        : 'px-3.5'} {active ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:bg-surface/60 hover:text-ink'}"
    >
      <item.icon class="size-[18px] shrink-0 {active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'}" strokeWidth={active ? 2.2 : 1.9} />
      <span class="flex flex-1 items-center gap-3 {fade}">
        <span class="flex-1">{t(item.label)}</span>
        {#if item.external}<ArrowUpRight class="size-3.5 text-ink-3" />{/if}
      </span>
    </a>
  {/snippet}
  {@render tip(t(item.label), anchor)}
{/snippet}

<!-- Section titles become a short rule on the rail, so workspace and manage stay apart. -->
{#snippet heading(text: string)}
  <p class="relative px-3.5 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
    <span class="block overflow-hidden {fade}">{text}</span>
    <span class="absolute top-[calc(50%-3px)] left-1/2 h-px w-5 -translate-x-1/2 bg-line-2 transition-opacity {ease} {collapsed ? 'opacity-100' : 'opacity-0'}" aria-hidden="true"></span>
  </p>
{/snippet}

{#snippet toggleButton(props: Record<string, unknown>)}
  <button
    {...props}
    type="button"
    onclick={() => sidebar.toggle()}
    aria-expanded={!collapsed}
    aria-controls="app-sidebar"
    aria-label={toggleLabel}
    aria-keyshortcuts={mac ? "Meta+B" : "Control+B"}
    class="group flex h-10 w-full items-center gap-3 overflow-hidden rounded-full text-[13px] font-medium text-ink-3 transition-[padding,background-color,color] {ease} hover:bg-surface/60 hover:text-ink-2 {collapsed
      ? 'px-[11px]'
      : 'px-3.5'}"
  >
    {#if collapsed}<PanelLeftOpen class="size-[18px] shrink-0" strokeWidth={1.9} />{:else}<PanelLeftClose class="size-[18px] shrink-0" strokeWidth={1.9} />{/if}
    <span class="flex flex-1 items-center gap-1 {fade}">
      <span class="flex-1 text-left">{t("nav.collapse")}</span>
      <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>B</Kbd>
    </span>
  </button>
{/snippet}

<aside
  id="app-sidebar"
  aria-label={t("brand.name")}
  class="sticky top-0 hidden h-dvh shrink-0 flex-col overflow-x-hidden overflow-y-auto px-4 pt-6 pb-4 transition-[width] {ease} lg:flex {collapsed ? 'w-[72px]' : 'w-[260px]'}"
>
  <div class="transition-[padding] {ease} {collapsed ? 'px-1' : 'px-2.5'}"><Wordmark compact={collapsed} /></div>
  {#if workspaceNav.some(visible)}
    <nav class="mt-9 flex flex-col gap-1" aria-label={t("nav.workspace")}>
      {@render heading(t("nav.workspace"))}
      {#each workspaceNav.filter(visible) as item (item.key)}{@render link(item)}{/each}
    </nav>
  {/if}
  <nav class="{workspaceNav.some(visible) ? 'mt-7' : 'mt-9'} flex flex-col gap-1" aria-label={t("nav.manage")}>
    {@render heading(t("nav.manage"))}
    {#each manageNav.filter(visible) as item (item.key)}{@render link(item)}{/each}
  </nav>
  <div class="mt-auto flex flex-col gap-2 pt-6">
    {#if collapsed}
      <div class="animate-[fade-in_220ms_ease-out]"><JobsRail /></div>
    {:else}
      <div class="w-[228px] animate-[fade-in_220ms_ease-out]"><JobsWidget /></div>
    {/if}
    {@render tip(`${toggleLabel} (${mac ? "⌘" : "Ctrl"}+B)`, toggleButton)}
  </div>
</aside>
