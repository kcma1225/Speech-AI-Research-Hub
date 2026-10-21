<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { CalendarClock, CircleCheck, KeyRound, LinkIcon } from "@lucide/svelte";
  import { api, ApiError } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Wordmark from "#lib/components/shell/Wordmark.svelte";

  /** 「設定新密碼」 from an admin-issued one-time reset link (`/reset/<token>`, public). */
  const token = $derived(page.params.token ?? "");
  type Info = { account: { name: string; username: string }; expiresAt: string };
  let status = $state<"loading" | "ready" | "invalid" | "error" | "done">("loading");
  let info = $state<Info | null>(null);
  let loadError = $state<string | null>(null);

  async function check() {
    status = "loading";
    try {
      info = await api.get<Info>(`/password-reset/${encodeURIComponent(token)}`);
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
    void token;
    void check();
  });

  let password = $state("");
  let confirm = $state("");
  let touched = $state({ password: false, confirm: false });
  let busy = $state(false);
  let formError = $state<string | null>(null);
  const passwordError = $derived(touched.password && password && password.trim().length < 8 ? t("crud.resetPage.tooShort") : null);
  const confirmError = $derived(touched.confirm && confirm && confirm !== password ? t("crud.resetPage.mismatch") : null);
  const valid = $derived(password.trim().length >= 8 && confirm === password);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    touched = { password: true, confirm: true };
    if (!valid) return;
    busy = true;
    formError = null;
    try {
      const result = await api.post<{ account: { name: string }; signedIn: boolean }>("/password-reset", { token, password, passwordConfirm: confirm });
      if (result.signedIn) {
        await session.load();
        toasts.show(t("crud.resetPage.done"), "success");
        await goto("/", { replaceState: true });
      } else status = "done";
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) status = "invalid";
      else formError = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>{t("crud.resetPage.title")} · Speech-AI Hub</title>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<main class="flex min-h-dvh flex-col bg-canvas px-4 pt-[max(20px,env(safe-area-inset-top))] pb-8 sm:px-10">
  <Wordmark />
  <div class="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
    {#if status === "loading"}
      <div class="flex flex-col gap-4" aria-busy="true"><Skeleton class="h-11 w-48" /><Skeleton class="h-5 w-72" /></div>
    {:else if status === "invalid"}
      <span class="mb-6 grid size-12 place-items-center rounded-2xl" style="background:var(--pill-rose);color:var(--pill-rose-ink)"><LinkIcon class="size-5" /></span>
      <h1 class="font-display text-[34px] leading-[1.08]">{t("crud.resetPage.title")}</h1>
      <p class="mt-3 text-[14px] leading-relaxed text-ink-3">{t("crud.resetPage.invalid")}</p>
      <Button href="/login" variant="primary" size="lg" class="mt-8 w-full">{t("crud.resetPage.toLogin")}</Button>
    {:else if status === "error"}
      <h1 class="font-display text-[34px] leading-[1.08]">{t("common.error")}</h1>
      <p class="mt-3 text-[14px] text-ink-3">{loadError ?? t("common.offline")}</p>
      <Button variant="primary" size="lg" class="mt-8 w-full" onclick={check}>{t("action.retry")}</Button>
    {:else if status === "done"}
      <span class="mb-6 grid size-12 place-items-center rounded-2xl" style="background:var(--pill-mint);color:var(--pill-mint-ink)"><CircleCheck class="size-5" /></span>
      <h1 class="font-display text-[34px] leading-[1.08]">{t("crud.resetPage.done")}</h1>
      <p class="mt-3 text-[14px] leading-relaxed text-ink-3">{t("crud.resetPage.doneHint")}</p>
      <Button href="/login" variant="primary" size="lg" class="mt-8 w-full">{t("crud.resetPage.toLogin")}</Button>
    {:else if info}
      <span class="mb-6 grid size-12 place-items-center rounded-2xl bg-surface-3 text-ink-2"><KeyRound class="size-5" /></span>
      <h1 class="font-display text-[38px] leading-none">{t("crud.resetPage.title")}</h1>
      <p class="mt-3 text-[14px] text-ink-2">{t("crud.resetPage.for", { name: info.account.name, username: info.account.username })}</p>
      <p class="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <CalendarClock class="size-3.5" />{t("crud.resetPage.expires", { date: formatDate(info.expiresAt, { dateStyle: "medium", timeStyle: "short" }) })}
      </p>
      <form class="mt-8 flex flex-col gap-4" onsubmit={submit} novalidate>
        <!-- Lets password managers store the new password under the right account. -->
        <input type="text" name="username" autocomplete="username" value={info.account.username} readonly hidden />
        <TextField type="password" label={t("crud.resetPage.password")} bind:value={password} autocomplete="new-password" required hint={t("manage.join.passwordHint")} error={passwordError} onblur={() => (touched.password = true)} />
        <TextField type="password" label={t("crud.resetPage.confirm")} bind:value={confirm} autocomplete="new-password" required error={confirmError} onblur={() => (touched.confirm = true)} />
        {#if formError}<p class="text-[13px] text-danger" role="alert">{formError}</p>{/if}
        <Button type="submit" variant="primary" size="lg" class="mt-2 w-full" loading={busy} disabled={!valid}>{t("crud.resetPage.submit")}</Button>
      </form>
    {/if}
  </div>
</main>
