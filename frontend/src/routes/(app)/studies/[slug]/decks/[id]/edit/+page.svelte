<script lang="ts">
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Presentation } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import QuartoEditor from "#lib/components/slides/editor/QuartoEditor.svelte";
  import type { SlideDetail } from "#lib/slides/types.ts";
  import { deckUrl } from "#lib/slides/util.ts";

  const id = $derived(page.params.id!);
  const studySlug = $derived(page.params.slug!);
  let deck = $state<SlideDetail | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);

  $effect(() => {
    const deckId = id;
    untrack(() => {
      deck = null;
      api.get<SlideDetail>(`/slides/${deckId}`).then(
        d => {
          deck = d;
          error = null;
          if (d.study && d.study.slug !== studySlug) void goto(`${deckUrl(d.study.slug, deckId, "edit")}${page.url.search}`, { replaceState: true });
        },
        e => (error = { status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }),
      );
    });
  });
</script>

<svelte:head><title>{deck ? `${deck.project.title} · ${t("slides.editor.title")} · ` : ""}Speech-AI Hub</title></svelte:head>

{#if error}
  <Card>
    <EmptyState title={error.status === 404 ? t("slides.notFound") : t("slides.loadError")} hint={error.status === 404 ? undefined : error.message} class="py-14">
      {#snippet icon()}<Presentation />{/snippet}
      {#snippet action()}<Button variant="secondary" href="/studies/{studySlug}?tab=decks">{t("slides.backToDecks")}</Button>{/snippet}
    </EmptyState>
  </Card>
{:else if !deck}
  <Skeleton class="mb-3 h-10 w-1/2" />
  <div class="grid gap-4 lg:grid-cols-2"><Skeleton class="h-[60vh] rounded-[22px]" /><Skeleton class="aspect-[16/10] rounded-[22px]" /></div>
{:else}
  {#key deck.project.id}<QuartoEditor {deck} {studySlug} />{/key}
{/if}
