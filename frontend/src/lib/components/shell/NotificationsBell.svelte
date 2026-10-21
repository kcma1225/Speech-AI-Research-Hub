<script lang="ts">
  import { Popover } from "bits-ui";
  import { Bell } from "@lucide/svelte";
  import { notificationsStore } from "#lib/stores/notifications.svelte.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import NotificationList from "./NotificationList.svelte";

  let open = $state(false);
  let clearOpen = $state(false);
  async function clearAll() {
    await notificationsStore.clear();
    toasts.show(t("crud.notifications.cleared"), "success");
  }
  $effect(() => {
    if (open) void notificationsStore.load();
  });
  const label = $derived(notificationsStore.unread ? `${t("notif.title")} (${notificationsStore.unread})` : t("notif.title"));
</script>

{#snippet trigger(props: Record<string, unknown>)}
  <button
    {...props}
    type="button"
    aria-label={label}
    class="relative grid size-10 place-items-center rounded-full border border-line bg-surface text-ink-2 transition-colors hover:text-ink data-[state=open]:border-ink-3 data-[state=open]:text-ink"
  >
    <Bell class="size-[18px]" />
    {#if notificationsStore.unread}
      <span class="absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-canvas bg-ink px-1 text-[10px] font-semibold text-primary-ink">
        {notificationsStore.unread > 9 ? "9+" : notificationsStore.unread}
      </span>
    {/if}
  </button>
{/snippet}

{#snippet actions()}
  <Button size="sm" variant="ghost" disabled={!notificationsStore.unread} onclick={() => notificationsStore.markRead()}>{t("notif.markAll")}</Button>
  <Button size="sm" variant="ghost" disabled={!notificationsStore.items.length} onclick={() => (clearOpen = true)}>{t("notif.clear")}</Button>
{/snippet}

{#if viewport.desktop}
  <Popover.Root bind:open>
    <Popover.Trigger>
      {#snippet child({ props })}{@render trigger(props)}{/snippet}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        align="end"
        sideOffset={10}
        class="z-50 flex max-h-[min(560px,80dvh)] w-[400px] flex-col rounded-[24px] border border-line bg-surface shadow-pop outline-none data-[state=open]:animate-[pop-in_140ms_ease-out]"
      >
        <div class="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <p class="text-[15px] font-semibold">{t("notif.title")}</p>
          <div class="flex">{@render actions()}</div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-2"><NotificationList onNavigate={() => (open = false)} /></div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  {@render trigger({ onclick: () => (open = true), "data-state": open ? "open" : "closed" })}
  <Sheet bind:open title={t("notif.title")}>
    <div class="-mx-2 mb-2 flex">{@render actions()}</div>
    <div class="-mx-2"><NotificationList onNavigate={() => (open = false)} /></div>
  </Sheet>
{/if}

<ConfirmDialog bind:open={clearOpen} title={t("crud.notifications.clearTitle")} description={t("crud.notifications.clearDescription")} confirmLabel={t("notif.clear")} onConfirm={clearAll} />
