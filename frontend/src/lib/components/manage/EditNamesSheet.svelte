<script lang="ts">
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { AdminUser } from "./manage.ts";

  /** Admin edit of an account's real name (真實姓名) and username (登入用). */
  let { open = $bindable(false), user, onSaved }: { open?: boolean; user: AdminUser | null; onSaved: (user: AdminUser) => void } = $props();

  const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
  let realName = $state("");
  let username = $state("");
  let usernameError = $state<string | null>(null);
  let formError = $state<string | null>(null);
  let busy = $state(false);
  $effect(() => {
    if (open && user) {
      realName = user.name;
      username = user.username;
      usernameError = formError = null;
    }
  });

  const cleanName = $derived(realName.replace(/\s+/g, " ").trim());
  const normalized = $derived(username.trim().toLowerCase());
  const nameOk = $derived([...cleanName].length >= 1 && [...cleanName].length <= 40);
  const formatOk = $derived(USERNAME_RE.test(normalized));
  const changed = $derived(!!user && (cleanName !== user.name || normalized !== user.username));

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!user || !nameOk || !formatOk || !changed) return;
    busy = true;
    usernameError = formError = null;
    const patch: { realName?: string; username?: string } = {};
    if (cleanName !== user.name) patch.realName = cleanName;
    if (normalized !== user.username) patch.username = normalized;
    try {
      const result = await api.patch<{ user: AdminUser }>(`/users/${user.id}`, patch);
      onSaved(result.user);
      toasts.show(t("manage.members.namesSaved", { name: result.user.name }), "success");
      open = false;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) usernameError = err.message;
      else formError = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet bind:open side="right" title={t("manage.members.editTitle")} description={t("manage.members.editDesc")}>
  {#snippet children()}
    <form id="edit-names-form" class="flex flex-col gap-4 pt-1" onsubmit={submit} novalidate>
      <TextField
        label={t("manage.join.realName")}
        bind:value={realName}
        maxlength={40}
        autocomplete="off"
        error={nameOk ? null : t("manage.join.realNameInvalid")}
      />
      <TextField
        label={t("manage.join.username")}
        bind:value={username}
        maxlength={32}
        autocomplete="off"
        autocapitalize="none"
        spellcheck={false}
        hint={t("manage.members.usernameHint")}
        error={usernameError ?? (normalized && !formatOk ? t("manage.join.usernameFormat") : null)}
        oninput={() => (usernameError = null)}
        onblur={() => (username = normalized)}
      />
      {#if formError}<p class="text-[13px] text-danger" role="alert">{formError}</p>{/if}
    </form>
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
    <Button type="submit" form="edit-names-form" variant="primary" loading={busy} disabled={!changed || !nameOk || !formatOk}>{t("action.save")}</Button>
  {/snippet}
</Sheet>
