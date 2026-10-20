<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { ArrowRight, AudioLines, MessageSquareQuote, Presentation, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { forgetAccount, rememberedAccounts, session } from "#lib/stores/session.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import Wordmark from "#lib/components/shell/Wordmark.svelte";

  const next = $derived.by(() => {
    const value = page.url.searchParams.get("next") ?? "/";
    return value.startsWith("/") && !value.startsWith("//") ? value : "/";
  });
  $effect(() => {
    if (session.user) void goto(next, { replaceState: true });
  });

  let accounts = $state<{ id: string; name: string }[]>([]);
  let chosen = $state<{ id: string; name: string } | null>(null);
  let name = $state("");
  let password = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);
  let passwordInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    const ids = rememberedAccounts();
    if (ids.length) api.get<{ accounts: { id: string; name: string }[] }>(`/auth/accounts?ids=${ids.join(",")}`).then(r => (accounts = r.accounts), () => {});
  });

  function choose(account: { id: string; name: string } | null) {
    chosen = account;
    error = null;
    password = "";
    queueMicrotask(() => passwordInput?.focus());
  }
  function forget(id: string) {
    forgetAccount(id);
    accounts = accounts.filter(a => a.id !== id);
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await session.login(chosen ? { userId: chosen.id, password } : { name: name.trim(), password });
      await goto(next, { replaceState: true });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  const features = [
    { icon: Presentation, key: "login.feature1" },
    { icon: AudioLines, key: "login.feature2" },
    { icon: MessageSquareQuote, key: "login.feature3" },
  ] as const;
</script>

<svelte:head><title>{t("login.title")} · Speech-AI Hub</title></svelte:head>

<div class="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
  <aside class="relative m-3 hidden flex-col justify-between overflow-hidden rounded-[32px] hero-gradient p-10 text-hero-ink lg:flex xl:p-14">
    <div class="[&_a_span]:!text-hero-ink"><Wordmark size="lg" /></div>
    <div>
      <h1 class="font-display text-[56px] leading-[1.02] whitespace-pre-line xl:text-[68px]">{t("login.hero")}</h1>
      <ul class="mt-10 flex flex-col gap-3.5">
        {#each features as f (f.key)}
          <li class="flex items-center gap-3 text-[15px]">
            <span class="grid size-9 place-items-center rounded-xl bg-white/55 backdrop-blur dark:bg-black/25"><f.icon class="size-[18px]" /></span>
            {t(f.key)}
          </li>
        {/each}
      </ul>
    </div>
    <p class="text-[13px] opacity-70">{t("brand.tagline")}</p>
    <!-- Decorative waveform -->
    <svg class="pointer-events-none absolute -right-10 bottom-36 w-[62%] opacity-35" viewBox="0 0 300 80" fill="currentColor" aria-hidden="true">
      {#each Array.from({ length: 50 }, (_, i) => 10 + Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)) * 62) as h, i (i)}
        <rect x={i * 6} y={40 - h / 2} width="3" height={h} rx="1.5" />
      {/each}
    </svg>
  </aside>

  <main class="flex flex-col px-5 pt-[max(20px,env(safe-area-inset-top))] pb-8 sm:px-10">
    <div class="lg:hidden"><Wordmark /></div>
    <div class="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
      <h2 class="font-display text-[42px] leading-none">{t("login.title")}</h2>
      <p class="mt-3 text-[14px] text-ink-3">{t("login.subtitle")}</p>

      {#if accounts.length && !chosen}
        <p class="mt-8 mb-2.5 text-[13px] font-medium text-ink-2">{t("login.remembered")}</p>
        <ul class="flex flex-col gap-2">
          {#each accounts as a (a.id)}
            <li class="group relative">
              <button type="button" onclick={() => choose(a)} class="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-left transition-colors hover:border-ink-3">
                <Avatar name={a.name} size={38} class="ring-0" />
                <span class="flex-1 text-[15px] font-medium">{a.name}</span>
                <ArrowRight class="mr-8 size-4 text-ink-3" />
              </button>
              <button
                type="button"
                onclick={() => forget(a.id)}
                aria-label="✕ {a.name}"
                class="absolute top-1/2 right-3 grid size-7 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink"><X class="size-3.5" /></button
              >
            </li>
          {/each}
        </ul>
        <div class="my-6 flex items-center gap-3 text-[12px] text-ink-3"><span class="h-px flex-1 bg-line"></span>{t("login.other")}<span class="h-px flex-1 bg-line"></span></div>
      {/if}

      <form class="flex flex-col gap-4 {accounts.length && !chosen ? '' : 'mt-8'}" onsubmit={submit}>
        {#if chosen}
          <div class="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
            <Avatar name={chosen.name} size={38} class="ring-0" />
            <span class="flex-1 text-[15px] font-medium">{chosen.name}</span>
            <Button size="sm" variant="ghost" onclick={() => choose(null)}>{t("login.other")}</Button>
          </div>
        {:else}
          <TextField label={t("login.name")} bind:value={name} autocomplete="username" required />
        {/if}
        <TextField bind:ref={passwordInput} type="password" label={t("login.password")} bind:value={password} autocomplete="current-password" required error={error} />
        <Button type="submit" variant="primary" size="lg" class="mt-2 w-full" loading={busy} disabled={!password || (!chosen && !name.trim())}>
          {busy ? t("login.submitting") : t("login.submit")}
        </Button>
      </form>
      <p class="mt-6 text-center text-[13px] text-ink-3">{t("login.noAccount")}</p>
    </div>
  </main>
</div>
