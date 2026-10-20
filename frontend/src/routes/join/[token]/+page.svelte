<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { AudioLines, CalendarClock, LinkIcon, MessageSquareQuote, Presentation } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Wordmark from "#lib/components/shell/Wordmark.svelte";
  import { roleLabel, roleTone } from "#lib/components/manage/manage.ts";
  import type { Role } from "#lib/types.ts";

  const token = $derived(page.params.token ?? "");

  type Invite = { role: Exclude<Role, "owner">; expiresAt: string | null };
  let status = $state<"loading" | "ready" | "invalid" | "error">("loading");
  let invite = $state<Invite | null>(null);
  let loadError = $state<string | null>(null);

  async function check() {
    status = "loading";
    try {
      invite = await api.get<Invite>(`/join/${encodeURIComponent(token)}`);
      status = "ready";
    } catch (err) {
      if (err instanceof ApiError && [400, 404, 410].includes(err.status)) status = "invalid";
      else {
        loadError = (err as Error).message;
        status = "error";
      }
    }
  }
  $effect(() => {
    void check();
  });

  let name = $state("");
  let password = $state("");
  let confirm = $state("");
  let touched = $state({ password: false, confirm: false });
  let nameError = $state<string | null>(null);
  let formError = $state<string | null>(null);
  let busy = $state(false);

  const passwordError = $derived(touched.password && password && password.length < 8 ? t("manage.join.short") : null);
  const confirmError = $derived(touched.confirm && confirm && confirm !== password ? t("manage.join.mismatch") : null);
  const valid = $derived(!!name.trim() && password.length >= 8 && confirm === password);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    touched = { password: true, confirm: true };
    if (!valid) return;
    busy = true;
    nameError = formError = null;
    try {
      const result = await api.post<{ account: { id: string; name: string } }>("/join", { token, name: name.trim(), password, passwordConfirm: confirm });
      await session.load();
      toasts.show(t("manage.join.welcome", { name: result.account.name }), "success");
      await goto("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) nameError = err.message;
      else if (err instanceof ApiError && err.status === 410) status = "invalid";
      else formError = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  const perks = [
    { icon: Presentation, key: "login.feature1" },
    { icon: AudioLines, key: "login.feature2" },
    { icon: MessageSquareQuote, key: "login.feature3" },
  ] as const;
</script>

<svelte:head>
  <title>{t("manage.join.pageTitle")} · Speech-AI Hub</title>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
  <aside class="relative m-3 hidden flex-col justify-between overflow-hidden rounded-[32px] hero-gradient p-10 text-hero-ink lg:flex xl:p-14">
    <div class="[&_a_span]:!text-hero-ink"><Wordmark size="lg" /></div>
    <div>
      <h1 class="font-display text-[56px] leading-[1.02] whitespace-pre-line xl:text-[68px]">{t("manage.join.hero")}</h1>
      <ul class="mt-10 flex flex-col gap-3.5">
        {#each perks as f (f.key)}
          <li class="flex items-center gap-3 text-[15px]">
            <span class="grid size-9 place-items-center rounded-xl bg-white/55 backdrop-blur dark:bg-black/25"><f.icon class="size-[18px]" /></span>
            {t(f.key)}
          </li>
        {/each}
      </ul>
    </div>
    <p class="text-[13px] opacity-70">{t("brand.tagline")}</p>
    <svg class="pointer-events-none absolute -right-10 bottom-36 w-[62%] opacity-35" viewBox="0 0 300 80" fill="currentColor" aria-hidden="true">
      {#each Array.from({ length: 50 }, (_, i) => 10 + Math.abs(Math.sin(i * 0.9 + 1) * Math.cos(i * 0.19)) * 62) as h, i (i)}
        <rect x={i * 6} y={40 - h / 2} width="3" height={h} rx="1.5" />
      {/each}
    </svg>
  </aside>

  <main class="flex flex-col px-5 pt-[max(20px,env(safe-area-inset-top))] pb-8 sm:px-10">
    <div class="lg:hidden"><Wordmark /></div>
    <div class="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
      {#if status === "loading"}
        <div class="flex flex-col gap-4" aria-busy="true">
          <Skeleton class="h-11 w-48" />
          <Skeleton class="h-5 w-72" />
          <p class="mt-4 flex items-center gap-2 text-[13px] text-ink-3"><Spinner class="size-4" />{t("manage.join.checking")}</p>
        </div>
      {:else if status === "invalid"}
        <span class="mb-6 grid size-12 place-items-center rounded-2xl" style="background:var(--pill-rose);color:var(--pill-rose-ink)"><LinkIcon class="size-5" /></span>
        <h2 class="font-display text-[38px] leading-[1.05]">{t("manage.join.invalidTitle")}</h2>
        <p class="mt-3 text-[14px] leading-relaxed text-ink-3">{t("manage.join.invalidHint")}</p>
        <Button href="/login" variant="primary" size="lg" class="mt-8 w-full">{t("manage.join.toLogin")}</Button>
      {:else if status === "error"}
        <h2 class="font-display text-[38px] leading-[1.05]">{t("common.error")}</h2>
        <p class="mt-3 text-[14px] text-ink-3">{loadError ?? t("common.offline")}</p>
        <Button variant="primary" size="lg" class="mt-8 w-full" onclick={check}>{t("action.retry")}</Button>
      {:else if invite}
        <h2 class="font-display text-[42px] leading-none">{t("manage.join.title")}</h2>
        <p class="mt-3 text-[14px] text-ink-3">{t("manage.join.invitedAs", { role: t(roleLabel(invite.role)) })}</p>
        <div class="mt-5 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
          <Pill tone={roleTone[invite.role]}>{t(roleLabel(invite.role))}</Pill>
          <span class="inline-flex items-center gap-1.5 text-ink-3">
            <CalendarClock class="size-3.5" />
            {invite.expiresAt ? t("manage.join.expires", { date: formatDate(invite.expiresAt, { dateStyle: "medium", timeStyle: "short" }) }) : t("manage.join.noExpiry")}
          </span>
        </div>
        {#if session.user}
          <p class="mt-5 rounded-2xl bg-surface-2 px-4 py-3 text-[13px] text-ink-2">{t("manage.join.signedInAs", { name: session.user.name })}</p>
        {/if}

        <form class="mt-8 flex flex-col gap-4" onsubmit={submit} novalidate>
          <TextField
            label={t("manage.join.name")}
            bind:value={name}
            autocomplete="username"
            maxlength={80}
            required
            hint={t("manage.join.nameHint")}
            error={nameError}
            oninput={() => (nameError = null)}
          />
          <TextField
            type="password"
            label={t("manage.join.password")}
            bind:value={password}
            autocomplete="new-password"
            required
            hint={t("manage.join.passwordHint")}
            error={passwordError}
            onblur={() => (touched.password = true)}
          />
          <TextField
            type="password"
            label={t("manage.join.confirm")}
            bind:value={confirm}
            autocomplete="new-password"
            required
            error={confirmError}
            onblur={() => (touched.confirm = true)}
          />
          {#if formError}<p class="text-[13px] text-danger" role="alert">{formError}</p>{/if}
          <Button type="submit" variant="primary" size="lg" class="mt-2 w-full" loading={busy} disabled={!valid}>
            {busy ? t("manage.join.submitting") : t("manage.join.submit")}
          </Button>
        </form>
        <p class="mt-6 text-center text-[13px] text-ink-3">
          {t("manage.join.haveAccount")} <a href="/login" class="font-medium text-ink underline-offset-4 hover:underline">{t("login.submit")}</a>
        </p>
      {/if}
    </div>
  </main>
</div>
