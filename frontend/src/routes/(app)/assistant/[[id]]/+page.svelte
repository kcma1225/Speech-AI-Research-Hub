<script lang="ts">
  import { page } from "$app/state";
  import { t } from "#lib/i18n.svelte.ts";
  import AssistantWorkspace from "#lib/components/agent/AssistantWorkspace.svelte";
  const id = $derived(page.params.id ?? null);
</script>

<svelte:head><title>{t("agent.title")} · Speech-AI Hub</title></svelte:head>

<AssistantWorkspace conversationId={id} />
