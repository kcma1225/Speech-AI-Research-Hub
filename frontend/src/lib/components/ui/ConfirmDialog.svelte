<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "./Button.svelte";
  import Sheet from "./Sheet.svelte";

  /** Confirmation for destructive actions. `onConfirm` may be async; errors keep the dialog open. */
  let { open = $bindable(false), title, description, confirmLabel, danger = true, onConfirm }: {
    open?: boolean;
    title: string;
    description?: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => unknown | Promise<unknown>;
  } = $props();
  let busy = $state(false);

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

<Sheet bind:open {title} {description} side="center">
  {#snippet children()}<div></div>{/snippet}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
    <Button variant={danger ? "danger" : "primary"} loading={busy} onclick={confirm}>{confirmLabel}</Button>
  {/snippet}
</Sheet>
