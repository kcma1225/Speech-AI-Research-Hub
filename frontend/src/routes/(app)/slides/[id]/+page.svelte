<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Presentation } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import type { SlideDetail } from "#lib/slides/types.ts";
  import { deckUrl } from "#lib/slides/util.ts";

  // v2 address of a deck (notifications, activity, jobs tray): decks now live inside their study.
  let error = $state<{ status: number; message: string } | null>(null);
  $effect(() => {
    const id = page.params.id!;
    api.get<SlideDetail>(`/slides/${id}`).then(
      d => {
        if (d.study) void goto(`${deckUrl(d.study.slug, id)}${location.hash}`, { replaceState: true });
        else error = { status: 404, message: "" };
      },
      e => (error = { status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }),
    );
  });
</script>

<svelte:head><title>{t("slides.title")} · Speech-AI Hub</title></svelte:head>

{#if error}
  <Card>
    <EmptyState title={error.status === 404 ? t("slides.notFound") : t("slides.loadError")} hint={error.status === 404 ? undefined : error.message} class="py-14">
      {#snippet icon()}<Presentation />{/snippet}
      {#snippet action()}<Button variant="secondary" href="/studies">{t("slides.backToStudies")}</Button>{/snippet}
    </EmptyState>
  </Card>
{:else}
  <Skeleton class="mb-3 h-11 w-2/3" />
  <Skeleton class="aspect-[16/10] rounded-[22px]" />
{/if}
