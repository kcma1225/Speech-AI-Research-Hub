<script lang="ts">
  import { page } from "$app/state";
  import { Ellipsis } from "@lucide/svelte";
  import { isActive, workspaceNav, manageNav } from "#lib/nav.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import MoreDrawer from "./MoreDrawer.svelte";

  let moreOpen = $state(false);
  const moreActive = $derived(manageNav.some(item => !item.external && isActive(item.href, page.url.pathname)));
  const tab = "flex flex-1 flex-col items-center justify-center gap-1 pt-2 pb-1.5 text-[11px] font-medium transition-colors";
</script>

<nav
  class="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
  aria-label={t("nav.workspace")}
>
  <div class="mx-auto flex max-w-xl px-2">
    {#each workspaceNav as item (item.key)}
      {@const active = isActive(item.href, page.url.pathname)}
      <a href={item.href} aria-current={active ? "page" : undefined} class="{tab} {active ? 'text-ink' : 'text-ink-3'}">
        <span class="grid h-7 w-12 place-items-center rounded-full transition-colors {active ? 'bg-surface-3' : ''}">
          <item.icon class="size-5" strokeWidth={active ? 2.2 : 1.8} />
        </span>
        {t(item.short ?? item.label)}
      </a>
    {/each}
    <button type="button" class="{tab} {moreActive || moreOpen ? 'text-ink' : 'text-ink-3'}" onclick={() => (moreOpen = true)}>
      <span class="grid h-7 w-12 place-items-center rounded-full {moreActive ? 'bg-surface-3' : ''}"><Ellipsis class="size-5" /></span>
      {t("nav.more")}
    </button>
  </div>
</nav>
<MoreDrawer bind:open={moreOpen} />
