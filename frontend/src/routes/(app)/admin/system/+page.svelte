<script lang="ts">
  import { goto } from "$app/navigation";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import LibrarySettings from "#lib/components/library/LibrarySettings.svelte";
  import AiUsageSection from "#lib/components/admin/AiUsageSection.svelte";

  /**
   * /admin/system — a simple stack of section components, one per module (append yours below; keep each section
   * self-contained: it loads and saves its own settings).
   */
  const isAdmin = $derived(session.user?.role === "admin");
  $effect(() => {
    if (session.user && !isAdmin) void goto("/", { replace: true });
  });
</script>

<svelte:head><title>{t("pages.adminSystem.title")} · Speech-AI Hub</title></svelte:head>

{#if isAdmin}
  <PageHeader title={t("pages.adminSystem.title")} subtitle={t("pages.adminSystem.subtitle")} />
  <div class="flex flex-col gap-5">
    <LibrarySettings />
    <AiUsageSection />
  </div>
{/if}
