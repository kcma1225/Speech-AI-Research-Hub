<script lang="ts">
  import { Check, Cpu, FlaskConical, Link2 } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import type { AdminUser } from "./manage.ts";

  /**
   * First-run guide on the admin home: shown while the system has no student or professor accounts (production starts
   * with only the initial admin). Steps link to model settings and invitations; studies are made by labmates.
   */
  let users = $state<AdminUser[] | null>(null);
  $effect(() => {
    api.get<{ users: AdminUser[] }>("/users").then(r => (users = r.users), () => {});
  });
  $effect(() => aiStatus.watch());
  const researchers = $derived(users?.filter(u => u.role !== "admin" && !u.disabled).length ?? 0);
  const modelsDone = $derived(aiStatus.all.some(r => r.status !== "unconfigured"));
  const steps = $derived([
    { href: "/admin/models", icon: Cpu, title: t("dash.setup.models"), hint: t("dash.setup.modelsHint"), done: modelsDone },
    { href: "/admin?tab=invites", icon: Link2, title: t("dash.setup.invite"), hint: t("dash.setup.inviteHint"), done: researchers > 0 },
    { href: null, icon: FlaskConical, title: t("dash.setup.study"), hint: t("dash.setup.studyHint"), done: false },
  ]);
</script>

{#if users && researchers === 0}
  <Card class="mb-5">
    <CardHeader title={t("dash.setup.title")} />
    <p class="-mt-2 mb-3 text-[13px] text-ink-3">{t("dash.setup.hint")}</p>
    <ol class="-mx-2 grid gap-1 md:grid-cols-3">
      {#each steps as step, i (step.title)}
        {@const Icon = step.icon}
        {#snippet inner()}
          <span class="grid size-8 shrink-0 place-items-center rounded-xl {step.done ? 'bg-primary text-primary-ink' : 'bg-surface-2 text-ink-2'}">{#if step.done}<Check class="size-4" />{:else}<Icon class="size-4" />{/if}</span>
          <span class="min-w-0">
            <span class="block text-[14px] font-semibold text-ink">{i + 1}. {step.title}</span>
            <span class="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{step.hint}</span>
          </span>
        {/snippet}
        <li>
          {#if step.href}
            <a href={step.href} class="flex h-full min-h-11 items-start gap-3 rounded-2xl px-2 py-2.5 hover:bg-surface-2">{@render inner()}</a>
          {:else}
            <div class="flex h-full items-start gap-3 rounded-2xl px-2 py-2.5">{@render inner()}</div>
          {/if}
        </li>
      {/each}
    </ol>
  </Card>
{/if}
