<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { session } from "#lib/stores/session.svelte.ts";
  import { jobsStore } from "#lib/stores/jobs.svelte.ts";
  import { notificationsStore } from "#lib/stores/notifications.svelte.ts";
  import { sidebar } from "#lib/stores/sidebar.svelte.ts";
  import Sidebar from "#lib/components/shell/Sidebar.svelte";
  import Topbar from "#lib/components/shell/Topbar.svelte";
  import BottomTabs from "#lib/components/shell/BottomTabs.svelte";
  import CommandPalette from "#lib/components/shell/CommandPalette.svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { ADMIN_HOME, adminMayOpen } from "#lib/nav.ts";
  import { people } from "#lib/people.svelte.ts";
  import NamesConfirmBanner from "#lib/components/people/NamesConfirmBanner.svelte";

  let { children } = $props();

  // Admin accounts are system-only: workspace pages send them to the admin home.
  const adminElsewhere = $derived(session.user?.role === "admin" && !adminMayOpen(page.url.pathname));
  $effect(() => {
    if (!session.user) void goto(`/login?next=${encodeURIComponent(page.url.pathname + page.url.search)}`, { replace: true });
    else if (adminElsewhere) void goto(ADMIN_HOME, { replace: true });
    else {
      jobsStore.start();
      notificationsStore.start();
      void people.ensure();
    }
  });
</script>

{#if session.user && !adminElsewhere}
  <a href="#main" class="sr-only z-[70] rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3">{t("nav.skip")}</a>
  <div class="flex min-h-dvh">
    <Sidebar />
    <div class="flex min-w-0 flex-1 flex-col lg:pr-6">
      <Topbar />
      <main id="main" tabindex="-1" class="flex-1 outline-none px-4 pt-2 pb-[calc(96px+env(safe-area-inset-bottom))] sm:px-6 lg:px-0 lg:pt-7 lg:pb-10">
        <!-- A collapsed sidebar frees ~190px; wide screens give it to the content (max-width eases with the rail). -->
        <div class="mx-auto w-full max-w-[1280px] transition-[max-width] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] {sidebar.collapsed ? 'lg:max-w-[1600px]' : ''}">
          <!-- Not on /assistant: its workspace fills the viewport, a banner above it would push the composer off screen. -->
          {#if !page.url.pathname.startsWith("/settings") && !page.url.pathname.startsWith("/assistant")}<NamesConfirmBanner />{/if}
          {@render children()}
        </div>
      </main>
    </div>
  </div>
  <BottomTabs />
  {#if session.user.role !== "admin"}<CommandPalette />{/if}
{/if}
