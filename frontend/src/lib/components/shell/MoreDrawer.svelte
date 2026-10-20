<script lang="ts">
  import { ArrowUpRight, ChevronRight } from "@lucide/svelte";
  import { manageNav, type NavItem } from "#lib/nav.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import JobsWidget from "./JobsWidget.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();
  const items = $derived(
    manageNav.filter(item => (!item.roles || (session.user && item.roles.includes(session.user.role))) && (!item.external || session.config.latexUrl)),
  );
  const hrefOf = (item: NavItem) => (item.key === "latex" ? session.config.latexUrl! : item.href);
</script>

<Sheet bind:open title={t("nav.more")}>
  <ul class="overflow-hidden rounded-2xl border border-line">
    {#each items as item (item.key)}
      <li class="border-b border-line last:border-0">
        <a
          href={hrefOf(item)}
          target={item.external ? "_blank" : undefined}
          rel={item.external ? "noopener noreferrer" : undefined}
          onclick={() => (open = false)}
          class="flex h-14 items-center gap-3.5 px-4 text-[15px] font-medium active:bg-surface-2"
        >
          <span class="grid size-9 place-items-center rounded-xl bg-surface-2 text-ink-2"><item.icon class="size-[18px]" /></span>
          <span class="flex-1">{t(item.label)}</span>
          {#if item.external}<ArrowUpRight class="size-4 text-ink-3" />{:else}<ChevronRight class="size-4 text-ink-3" />{/if}
        </a>
      </li>
    {/each}
  </ul>
  <div class="mt-4"><JobsWidget compact /></div>
</Sheet>
