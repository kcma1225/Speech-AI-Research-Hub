<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import type { StudyTabProps } from "./registry.ts";

  /** Stand-in for a tab whose module has not landed yet (see registry.ts). */
  let { tab }: StudyTabProps = $props();
</script>

<Card>
  <EmptyState title={t("studies.placeholder.title", { tab: t(tab.label) })} hint={t("studies.placeholder.hint")} class="py-14">
    {#snippet icon()}<tab.icon />{/snippet}
  </EmptyState>
</Card>
