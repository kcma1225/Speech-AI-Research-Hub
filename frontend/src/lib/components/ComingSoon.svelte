<script lang="ts">
  import { Hammer } from "@lucide/svelte";
  import type { MessageKey } from "#lib/messages.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";

  let { title }: { title: MessageKey } = $props();
</script>

<PageHeader title={t(title)} />
<Card><EmptyState title={t("common.comingSoon")}>{#snippet icon()}<Hammer />{/snippet}</EmptyState></Card>
