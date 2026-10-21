<script lang="ts">
  import { Check, Copy, Link2, TriangleAlert } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { expiryChoices, invitableRoles, roleLabel, type ExpiryChoice, type InvitableRole, type Invitation } from "./manage.ts";

  /** Create-invitation sheet. After creation it shows the raw link once; closing forgets it. */
  let { open = $bindable(false), onCreated }: { open?: boolean; onCreated: (invitation: Invitation) => void } = $props();

  let role = $state<InvitableRole>("student");
  let expiresIn = $state<ExpiryChoice>("7d");
  let singleUse = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let created = $state<{ url: string; summary: string } | null>(null);
  let copied = $state(false);
  let linkInput = $state<HTMLTextAreaElement | null>(null);

  // Reset when the sheet closes so the raw link is never shown again, and so the next invitation starts from the
  // safe defaults (never silently inherits "professor" or the admin flag from the previous one).
  $effect(() => {
    if (!open) {
      created = null;
      copied = false;
      error = null;
      role = "student";
      expiresIn = "7d";
      singleUse = true;
    }
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      const result = await api.post<{ invitation: Invitation; token: string; url: string }>("/invitations", {
        role,
        expiresIn,
        maxUses: singleUse ? 1 : null,
      });
      const url = /^https?:\/\//.test(result.url) ? result.url : new URL(result.url, location.origin).href;
      created = {
        url,
        summary: t("manage.invites.summary", {
          role: t(roleLabel(role)),
          expiry: t(`manage.expiry.${expiresIn}`),
          uses: t(singleUse ? "manage.invites.singleUse" : "manage.invites.unlimited"),
        }),
      };
      onCreated({ uses: [], ...result.invitation });
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
        // Plain-HTTP deployments have no async clipboard API.
        linkInput?.select();
        if (!document.execCommand("copy")) throw new Error();
      }
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      linkInput?.select();
      toasts.show(t("manage.invites.copyFailed"), "error");
    }
  }
</script>

<Sheet bind:open side="right" dirty={created ? false : undefined} title={created ? t("manage.invites.ready") : t("manage.invites.sheet.title")} description={created ? created.summary : t("manage.invites.sheet.desc")}>
  {#snippet children()}
    {#if created}
      <div class="flex flex-col gap-4 pt-2">
        <div class="flex gap-3 rounded-2xl p-3.5 text-[13px] leading-relaxed" style="background:var(--pill-butter);color:var(--pill-butter-ink)" role="alert">
          <TriangleAlert class="mt-0.5 size-4 shrink-0" />
          <p>{t("manage.invites.onceWarning")}</p>
        </div>
        <div class="rounded-2xl border border-line bg-surface-2 p-3">
          <label class="flex items-center gap-2 text-[12px] font-medium text-ink-3" for="invite-link"><Link2 class="size-3.5" />URL</label>
          <textarea
            id="invite-link"
            bind:this={linkInput}
            readonly
            rows="2"
            value={created.url}
            onfocus={e => e.currentTarget.select()}
            class="mt-1.5 w-full resize-none bg-transparent font-mono text-[13px] leading-relaxed break-all text-ink outline-none"
          ></textarea>
        </div>
        <Button variant="primary" size="lg" class="w-full" onclick={copy}>
          {#if copied}<Check />{t("manage.invites.copied")}{:else}<Copy />{t("manage.invites.copy")}{/if}
        </Button>
      </div>
    {:else}
      <form id="invite-form" class="flex flex-col gap-6 pt-2" onsubmit={submit}>
        <div class="flex flex-col gap-2">
          <span class="text-[13px] font-medium text-ink-2">{t("manage.invites.field.role")}</span>
          <Segmented bind:value={role} label={t("manage.invites.field.role")} class="w-full" options={invitableRoles.map(r => ({ value: r, label: t(roleLabel(r)) }))} />
          <p class="text-[12.5px] text-ink-3">{t(`manage.role.hint.${role}`)}</p>
        </div>
        <div class="flex flex-col gap-2">
          <span class="text-[13px] font-medium text-ink-2">{t("manage.invites.field.expiry")}</span>
          <Select bind:value={expiresIn} label={t("manage.invites.field.expiry")} class="w-full" options={expiryChoices.map(c => ({ value: c, label: t(`manage.expiry.${c}`) }))} />
        </div>
        <div class="flex items-start justify-between gap-4 rounded-2xl border border-line p-4">
          <div>
            <p class="text-[14px] font-medium text-ink">{t("manage.invites.field.single")}</p>
            <p class="mt-0.5 text-[12.5px] text-ink-3">{t("manage.invites.field.singleHint")}</p>
          </div>
          <Switch bind:checked={singleUse} label={t("manage.invites.field.single")} />
        </div>
        {#if error}<p class="text-[13px] text-danger" role="alert">{error}</p>{/if}
      </form>
    {/if}
  {/snippet}
  {#snippet footer()}
    {#if created}
      <Button variant="secondary" onclick={() => (open = false)}>{t("manage.invites.done")}</Button>
    {:else}
      <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
      <Button type="submit" form="invite-form" variant="primary" loading={busy}>{t("manage.invites.submit")}</Button>
    {/if}
  {/snippet}
</Sheet>
