<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "./Button.svelte";
  import Sheet from "./Sheet.svelte";
  import type { CloseGuard } from "./close-guard.svelte.ts";

  /**
   * The "discard unsaved changes?" confirm a guarded sheet shows. Focus starts on Keep editing; Esc, the backdrop and
   * Keep editing all just close this layer, and focus goes back to `returnFocus()` (the field last focused in the
   * sheet; a backdrop click would otherwise leave it on <body>).
   */
  let { guard, busy = false, onDiscard, returnFocus }: { guard: CloseGuard; busy?: boolean; onDiscard: () => void; returnFocus: () => HTMLElement | null } = $props();
  let keepButton = $state<HTMLElement | null>(null);
</script>

<Sheet
  bind:open={guard.confirming}
  guard={false}
  side="center"
  title={t("discard.title")}
  description={t(busy ? "discard.busyDescription" : "discard.description")}
  onOpenAutoFocus={e => {
    e.preventDefault();
    keepButton?.focus();
  }}
  onCloseAutoFocus={e => {
    const el = returnFocus();
    if (!el?.isConnected) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
  }}
>
  {#snippet children()}{/snippet}
  {#snippet footer()}
    <Button bind:ref={keepButton} variant="ghost" onclick={() => (guard.confirming = false)}>{t("discard.keep")}</Button>
    <Button variant="danger" onclick={onDiscard}>{t("discard.confirm")}</Button>
  {/snippet}
</Sheet>
