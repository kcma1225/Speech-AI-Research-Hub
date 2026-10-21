<script lang="ts">
  import { Check, Copy, KeyRound, Link2, TriangleAlert } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { AdminUser } from "./manage.ts";

  /**
   * 「重設密碼」 for another account (admins): creates a one-time reset link (POST /users/:id/password-reset) and shows
   * it once. The admin never sees the new password; using the link signs out every device of the account.
   */
  let { open = $bindable(false), user }: { open?: boolean; user: AdminUser | null } = $props();

  const choices = ["1h", "1d", "3d", "7d"] as const;
  let expiresIn = $state<(typeof choices)[number]>("1d");
  let revokeSessions = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let created = $state<{ url: string; expiresAt: string; sessions: number } | null>(null);
  let copied = $state(false);
  let revoking = $state(false);
  let linkInput = $state<HTMLTextAreaElement | null>(null);

  // The raw link is forgotten when the sheet closes; the next link starts from the defaults.
  $effect(() => {
    if (!open) {
      created = null;
      copied = false;
      error = null;
      expiresIn = "1d";
      revokeSessions = true;
    }
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!user) return;
    busy = true;
    error = null;
    try {
      const result = await api.post<{ reset: { id: string; expires_at: string; revoked_sessions: number }; url: string }>(`/users/${user.id}/password-reset`, { expiresIn, revokeSessions });
      created = { url: /^https?:\/\//.test(result.url) ? result.url : new URL(result.url, location.origin).href, expiresAt: result.reset.expires_at, sessions: result.reset.revoked_sessions };
      toasts.show(t("crud.reset.created"), "success");
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function copy() {
    if (!created) return;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(created.url);
      else {
        linkInput?.select();
        if (!document.execCommand("copy")) throw new Error();
      }
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      linkInput?.select();
      toasts.show(t("crud.reset.copyFailed"), "error");
    }
  }

  async function revoke() {
    if (!user) return;
    revoking = true;
    try {
      await api.del(`/users/${user.id}/password-reset`);
      toasts.show(t("crud.reset.revoked"), "success");
      open = false;
    } catch (err) {
      toasts.show((err as Error).message, "error");
    } finally {
      revoking = false;
    }
  }
</script>

<Sheet
  bind:open
  side="right"
  dirty={created ? false : undefined}
  title={created ? t("crud.reset.linkTitle") : t("crud.reset.title", { name: user?.name ?? "" })}
  description={created ? undefined : t("crud.reset.description")}
>
  {#snippet children()}
    {#if created}
      <div class="flex flex-col gap-4 pt-2">
        <div class="flex gap-3 rounded-2xl p-3.5 text-[13px] leading-relaxed" style="background:var(--pill-butter);color:var(--pill-butter-ink)" role="alert">
          <TriangleAlert class="mt-0.5 size-4 shrink-0" />
          <p>{t("crud.reset.linkHint", { name: user?.name ?? "", expires: formatDate(created.expiresAt, { dateStyle: "medium", timeStyle: "short" }) })}</p>
        </div>
        <div class="rounded-2xl border border-line bg-surface-2 p-3">
          <label class="flex items-center gap-2 text-[12px] font-medium text-ink-3" for="reset-link"><Link2 class="size-3.5" />URL</label>
          <textarea
            id="reset-link"
            bind:this={linkInput}
            readonly
            rows="3"
            value={created.url}
            onfocus={e => e.currentTarget.select()}
            class="mt-1.5 w-full resize-none bg-transparent font-mono text-[13px] leading-relaxed break-all text-ink outline-none"
          ></textarea>
        </div>
        <Button variant="primary" size="lg" class="w-full" onclick={copy}>
          {#if copied}<Check />{t("crud.reset.copied")}{:else}<Copy />{t("crud.reset.copy")}{/if}
        </Button>
        {#if created.sessions}<p class="text-[12.5px] text-ink-3">{t("crud.reset.sessionsRevoked", { n: created.sessions })}</p>{/if}
      </div>
    {:else}
      <form id="reset-form" class="flex flex-col gap-6 pt-2" onsubmit={submit}>
        <div class="flex flex-col gap-2">
          <span class="text-[13px] font-medium text-ink-2">{t("crud.reset.expires")}</span>
          <Select bind:value={expiresIn} label={t("crud.reset.expires")} class="w-full" options={choices.map(c => ({ value: c, label: t(`crud.reset.exp.${c}`) }))} />
        </div>
        <div class="flex items-start justify-between gap-4 rounded-2xl border border-line p-4">
          <div>
            <p class="text-[14px] font-medium text-ink">{t("crud.reset.revokeSessions")}</p>
            <p class="mt-0.5 text-[12.5px] text-ink-3">{t("crud.reset.revokeSessionsHint")}</p>
          </div>
          <Switch bind:checked={revokeSessions} label={t("crud.reset.revokeSessions")} />
        </div>
        {#if error}<p class="text-[13px] text-danger" role="alert">{error}</p>{/if}
      </form>
    {/if}
  {/snippet}
  {#snippet footer()}
    {#if created}
      <Button variant="ghost" class="text-danger hover:text-danger" loading={revoking} onclick={revoke}>{t("crud.reset.revoke")}</Button>
      <Button variant="secondary" onclick={() => (open = false)}>{t("crud.reset.done")}</Button>
    {:else}
      <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
      <Button type="submit" form="reset-form" variant="primary" loading={busy}><KeyRound />{t("crud.reset.create")}</Button>
    {/if}
  {/snippet}
</Sheet>
