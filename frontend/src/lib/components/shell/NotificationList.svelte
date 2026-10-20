<script lang="ts">
  import { AudioLines, Bell, Info, Presentation } from "@lucide/svelte";
  import { notificationsStore } from "#lib/stores/notifications.svelte.ts";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";

  let { onNavigate }: { onNavigate?: () => void } = $props();
  const icons = { slide: Presentation, media: AudioLines, system: Info };
</script>

{#if notificationsStore.loading && notificationsStore.items.length === 0}
  <div class="flex flex-col gap-3 p-2">
    {#each [0, 1, 2] as i (i)}<Skeleton class="h-14" />{/each}
  </div>
{:else if notificationsStore.items.length === 0}
  <EmptyState title={t("notif.empty")} hint={t("notif.emptyHint")}>
    {#snippet icon()}<Bell />{/snippet}
  </EmptyState>
{:else}
  <ul class="flex flex-col gap-0.5">
    {#each notificationsStore.items as n (n.id)}
      {@const Icon = icons[n.kind] ?? Info}
      <li>
        <a
          href={n.url}
          onclick={() => {
            if (!n.read_at) void notificationsStore.markRead([n.id]);
            onNavigate?.();
          }}
          class="flex gap-3 rounded-2xl p-2.5 transition-colors hover:bg-surface-2"
        >
          <span class="relative grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2 [&_svg]:size-4">
            <Icon />
            {#if !n.read_at}<span class="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface bg-[var(--pill-peach-ink)]"></span>{/if}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13.5px] {n.read_at ? 'text-ink-2' : 'font-semibold text-ink'}">{n.title}</span>
            {#if n.body}<span class="mt-0.5 line-clamp-2 block text-[12.5px] text-ink-3">{n.body}</span>{/if}
            <span class="mt-1 block text-[11.5px] text-ink-3">{relativeTime(n.created_at)}</span>
          </span>
        </a>
      </li>
    {/each}
  </ul>
{/if}
