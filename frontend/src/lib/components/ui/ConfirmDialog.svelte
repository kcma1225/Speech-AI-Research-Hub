<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "./Button.svelte";
  import Sheet from "./Sheet.svelte";

  /**
   * Confirmation for destructive actions. `onConfirm` may be async; errors keep the dialog open.
   * Focus starts on Cancel and returns to whatever opened the dialog; when that element is gone
   * (e.g. the deleted row), it goes to `returnFocus` instead.
   */
  let { open = $bindable(false), title, description, confirmLabel, danger = true, onConfirm, returnFocus = null }: {
    open?: boolean;
    title: string;
    description?: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => unknown | Promise<unknown>;
    returnFocus?: HTMLElement | null;
  } = $props();
  let busy = $state(false);
  let cancelButton = $state<HTMLElement | null>(null);
  let opener: HTMLElement | null = null;

  // Pre-effect: runs before the dialog mounts and takes focus.
  $effect.pre(() => {
    if (open && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) opener = document.activeElement;
  });

  async function confirm() {
    busy = true;
    try {
      await onConfirm();
      open = false;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet
  bind:open
  {title}
  {description}
  side="center"
  onOpenAutoFocus={e => {
    e.preventDefault();
    cancelButton?.focus();
  }}
  onCloseAutoFocus={e => {
    const target = opener?.isConnected ? opener : returnFocus?.isConnected ? returnFocus : null;
    opener = null;
    if (!target) return;
    e.preventDefault();
    target.focus({ preventScroll: true });
  }}
>
  {#snippet children()}{/snippet}
  {#snippet footer()}
    <Button bind:ref={cancelButton} variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
    <Button variant={danger ? "danger" : "primary"} loading={busy} onclick={confirm}>{confirmLabel}</Button>
  {/snippet}
</Sheet>
