<script lang="ts">
  import { page } from "$app/state";
  import { ArrowLeft, House } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Wordmark from "#lib/components/shell/Wordmark.svelte";

  const missing = $derived(page.status === 404);
</script>

<svelte:head><title>{missing ? t("error.notFound") : t("common.error")} · Speech-AI Hub</title></svelte:head>

<div class="flex min-h-dvh flex-col px-5 pt-[max(20px,env(safe-area-inset-top))] pb-8 sm:px-10">
  <Wordmark />
  <main class="mx-auto flex w-full max-w-[440px] flex-1 flex-col items-center justify-center py-10 text-center">
    <p class="font-display text-[96px] leading-none text-ink-3 tabular-nums sm:text-[120px]">{page.status}</p>
    <h1 class="mt-4 font-display text-[32px] leading-tight sm:text-[38px]">{missing ? t("error.notFound") : t("common.error")}</h1>
    <p class="mt-3 text-[14px] leading-relaxed text-ink-3">{missing ? t("error.notFoundHint") : (page.error?.message ?? t("common.offline"))}</p>
    <div class="mt-8 flex flex-wrap justify-center gap-2">
      <Button variant="secondary" onclick={() => history.back()}><ArrowLeft />{t("error.back")}</Button>
      <Button variant="primary" href={session.user ? "/" : "/login"}><House />{session.user ? t("error.home") : t("login.submit")}</Button>
    </div>
  </main>
</div>
