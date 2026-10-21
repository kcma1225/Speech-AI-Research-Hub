<script lang="ts">
  import { UserRoundPen, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";

  /** One-time, non-blocking prompt for accounts whose names were split automatically (migration 0112). */
  const key = $derived(`hub-names-banner-dismissed:${session.user?.id ?? ""}`);
  let dismissed = $state(false);
  $effect(() => {
    try {
      dismissed = localStorage.getItem(key) === "1";
    } catch {
      dismissed = false;
    }
  });
  function dismiss() {
    dismissed = true;
    try {
      localStorage.setItem(key, "1");
    } catch {}
  }
  const show = $derived(!!session.user && !session.user.names_confirmed && !dismissed);
</script>

{#if show}
  <div class="mb-4 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center" role="status">
    <span class="grid size-10 shrink-0 place-items-center rounded-xl" style="background:var(--pill-peach);color:var(--pill-peach-ink)"><UserRoundPen class="size-5" /></span>
    <div class="min-w-0 flex-1">
      <p class="text-[14px] font-semibold text-ink">{t("people.confirm.title")}</p>
      <p class="mt-0.5 text-[13px] leading-relaxed text-ink-3">{t("people.confirm.body")}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <Button href="/settings?tab=account" variant="primary" size="sm" class="min-h-10 flex-1 sm:flex-none">{t("people.confirm.action")}</Button>
      <Button variant="ghost" size="sm" class="min-h-10" onclick={dismiss} aria-label={t("people.confirm.dismiss")}>
        <span class="sm:hidden"><X class="size-4" /></span><span class="hidden sm:inline">{t("people.confirm.dismiss")}</span>
      </Button>
    </div>
  </div>
{/if}
