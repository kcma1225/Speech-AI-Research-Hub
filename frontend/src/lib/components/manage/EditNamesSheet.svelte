<script lang="ts">
  import { api, ApiError } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import PersonNameFields from "#lib/components/people/PersonNameFields.svelte";
  import { emptyNameForm, nameFormFrom, nameFormPayload, nameFormValid, sameNameForm, type NameForm } from "#lib/people.ts";
  import { displayName } from "#lib/people.svelte.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { AdminUser } from "./manage.ts";

  /** Admin edit of an account's structured names and username (登入用). */
  let { open = $bindable(false), user, onSaved }: { open?: boolean; user: AdminUser | null; onSaved: (user: AdminUser) => void } = $props();

  const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
  let names = $state<NameForm>(emptyNameForm());
  let username = $state("");
  let usernameError = $state<string | null>(null);
  let formError = $state<string | null>(null);
  let busy = $state(false);
  $effect(() => {
    if (open && user) {
      names = nameFormFrom(user.person);
      username = user.username;
      usernameError = formError = null;
    }
  });

  const normalized = $derived(username.trim().toLowerCase());
  const nameOk = $derived(nameFormValid(names));
  const namesChanged = $derived(!!user && !sameNameForm(names, nameFormFrom(user.person)));
  const formatOk = $derived(USERNAME_RE.test(normalized));
  const changed = $derived(!!user && (namesChanged || normalized !== user.username));

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!user || !nameOk || !formatOk || !changed) return;
    busy = true;
    usernameError = formError = null;
    const patch: { names?: ReturnType<typeof nameFormPayload>; username?: string } = {};
    if (namesChanged) patch.names = nameFormPayload(names);
    if (normalized !== user.username) patch.username = normalized;
    try {
      const result = await api.patch<{ user: AdminUser }>(`/users/${user.id}`, patch);
      onSaved(result.user);
      toasts.show(t("manage.members.namesSaved", { name: displayName(result.user) }), "success");
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
      <PersonNameFields bind:value={names} showErrors idPrefix="admin-names" />
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
