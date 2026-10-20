<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { session } from "#lib/stores/session.svelte.ts";
  import { jobsStore } from "#lib/stores/jobs.svelte.ts";
  import { notificationsStore } from "#lib/stores/notifications.svelte.ts";
  import Sidebar from "#lib/components/shell/Sidebar.svelte";
  import Topbar from "#lib/components/shell/Topbar.svelte";
  import BottomTabs from "#lib/components/shell/BottomTabs.svelte";
  import CommandPalette from "#lib/components/shell/CommandPalette.svelte";

  let { children } = $props();

  $effect(() => {
    if (!session.user) void goto(`/login?next=${encodeURIComponent(page.url.pathname + page.url.search)}`, { replaceState: true });
    else {
      jobsStore.start();
      notificationsStore.start();
    }
  });
</script>

{#if session.user}
  <div class="flex min-h-dvh">
    <Sidebar />
    <div class="flex min-w-0 flex-1 flex-col lg:pr-6">
      <Topbar />
      <main class="flex-1 px-4 pt-2 pb-[calc(96px+env(safe-area-inset-bottom))] sm:px-6 lg:px-0 lg:pt-7 lg:pb-10">
        <div class="mx-auto w-full max-w-[1280px]">{@render children()}</div>
      </main>
    </div>
  </div>
  <BottomTabs />
  <CommandPalette />
{/if}
