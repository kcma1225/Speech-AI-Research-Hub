<script lang="ts">
  import { page } from "$app/state";
  import { ArrowUpRight } from "@lucide/svelte";
  import { canSee, hrefOf as resolveHref, isActive, manageNav, workspaceNav, type NavItem } from "#lib/nav.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Wordmark from "./Wordmark.svelte";
  import JobsWidget from "./JobsWidget.svelte";

  const visible = (item: NavItem) => canSee(item, session.user, session.config);
  const hrefOf = (item: NavItem) => resolveHref(item, session.config);
</script>

{#snippet link(item: NavItem)}
  {@const active = !item.external && isActive(item.href, page.url.pathname)}
  <a
    href={hrefOf(item)}
    target={item.external ? "_blank" : undefined}
    rel={item.external ? "noopener noreferrer" : undefined}
    aria-current={active ? "page" : undefined}
    class="group flex h-10 items-center gap-3 rounded-full px-3.5 text-[14px] font-medium transition-colors {active
      ? 'bg-surface text-ink shadow-card'
      : 'text-ink-2 hover:bg-surface/60 hover:text-ink'}"
  >
    <item.icon class="size-[18px] {active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'}" strokeWidth={active ? 2.2 : 1.9} />
    <span class="flex-1">{t(item.label)}</span>
    {#if item.external}<ArrowUpRight class="size-3.5 text-ink-3" />{/if}
  </a>
{/snippet}

<aside class="sticky top-0 hidden h-dvh w-[260px] shrink-0 flex-col px-4 pt-6 pb-4 lg:flex">
  <div class="px-2.5"><Wordmark /></div>
  {#if workspaceNav.some(visible)}
    <nav class="mt-9 flex flex-col gap-1" aria-label={t("nav.workspace")}>
      <p class="px-3.5 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{t("nav.workspace")}</p>
      {#each workspaceNav.filter(visible) as item (item.key)}{@render link(item)}{/each}
    </nav>
  {/if}
  <nav class="{workspaceNav.some(visible) ? 'mt-7' : 'mt-9'} flex flex-col gap-1" aria-label={t("nav.manage")}>
    <p class="px-3.5 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{t("nav.manage")}</p>
    {#each manageNav.filter(visible) as item (item.key)}{@render link(item)}{/each}
  </nav>
  <div class="mt-auto pt-6"><JobsWidget /></div>
</aside>
