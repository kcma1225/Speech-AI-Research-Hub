<script lang="ts">
  import { fly } from "svelte/transition";
  import { Activity, Boxes, Link2, Unlink, X } from "@lucide/svelte";
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import { aiApi, ROLE_KEYS, STATE_KEYS, toErrorBody, type AiErrorBody, type Binding, type Capability, type TargetInput } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { ROLE_CAP } from "#lib/ai/routing.ts";
  import { aiStatus, type AiRole } from "#lib/ai/status.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import CheckCircle from "#lib/components/ui/CheckCircle.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";
  import StateDot from "../StateDot.svelte";
  import VisionBadge from "../../vision/VisionBadge.svelte";
  import ProviderIcon from "../ProviderIcon.svelte";
  import TargetPicker from "./TargetPicker.svelte";

  /** 功能綁定: tick several functions and bind them all to one model or group, or change one at a time. */
  let { onSwitchWizard }: { onSwitchWizard?: () => void } = $props();

  const sections: Array<{ cap: Capability; title: MessageKey; roles: AiRole[] }> = [
    { cap: "chat", title: "aiAdmin.bindings.section.chat", roles: ["assistant", "writing", "slides", "analysis", "fast"] },
    { cap: "embedding", title: "aiAdmin.bindings.section.embedding", roles: ["embedding"] },
    { cap: "asr", title: "aiAdmin.bindings.section.asr", roles: ["asr", "asr_live"] },
  ];

  let selected = $state<AiRole[]>([]);
  let busy = $state(false);
  let probing = $state(false);
  let error = $state<AiErrorBody | null>(null);
  let pickerOpen = $state(false);
  let pickerRoles = $state<AiRole[]>([]);

  const binding = (role: AiRole): Binding => adminStore.binding(role) ?? { role, target: null, params: {}, updated_at: null, status: null };
  const caps = $derived([...new Set(selected.map(r => ROLE_CAP[r]))]);
  const pickerCap = $derived.by((): Capability | null => {
    const c = [...new Set(pickerRoles.map(r => ROLE_CAP[r]))];
    return c.length === 1 ? c[0]! : null;
  });
  const currentKey = $derived.by(() => {
    if (pickerRoles.length !== 1) return null;
    const b = binding(pickerRoles[0]!);
    return b.target ? (b.target.type === "model" ? `model:${b.target.model_id}` : `group:${b.target.group_id}`) : null;
  });

  const toggle = (role: AiRole, on: boolean) => (selected = on ? [...new Set([...selected, role])] : selected.filter(r => r !== role));
  const toggleAll = (roles: AiRole[], on: boolean) => (selected = on ? [...new Set([...selected, ...roles])] : selected.filter(r => !roles.includes(r)));
  const roleNames = (roles: AiRole[]) => roles.map(r => t(ROLE_KEYS[r].label)).join(i18n.locale === "en" ? ", " : "、");

  function openPicker(roles: AiRole[]) {
    pickerRoles = roles;
    pickerOpen = true;
  }

  async function apply(roles: AiRole[], target: TargetInput | null, label = "") {
    busy = true;
    error = null;
    try {
      const r = await adminStore.bind(roles, target);
      toasts.show(target ? t("aiAdmin.bindings.boundMany", { roles: roleNames(roles), target: label }) : t("aiAdmin.bindings.unboundMany", { roles: roleNames(roles) }), "success");
      for (const w of r.warnings) toasts.show(w, "default", 6000);
      selected = [];
      void aiStatus.refresh();
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      busy = false;
    }
  }

  async function probe() {
    probing = true;
    try {
      await aiApi.post("/admin/ai/health/probe");
      await adminStore.reloadBindings();
      void aiStatus.refresh();
      toasts.show(t("aiAdmin.bindings.probed"), "success");
    } catch (e) {
      toasts.show(toErrorBody(e).error, "error");
    } finally {
      probing = false;
    }
  }

  const targetProvider = (b: Binding) => (b.target?.type === "model" ? adminStore.model(b.target.model_id)?.provider_id : null);
</script>

<section class="flex flex-col gap-5 pb-24">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <p class="max-w-[62ch] text-[13.5px] text-ink-3">{t("aiAdmin.bindings.hint")}</p>
    <Button variant="secondary" loading={probing} onclick={probe}><Activity />{t("aiAdmin.bindings.probeNow")}</Button>
  </div>

  {#if error}
    <AiErrorPanel {error}>
      {#snippet actions()}
        {#if error?.code === "embedding_model_change_requires_switch" && onSwitchWizard}
          <Button size="sm" variant="primary" onclick={onSwitchWizard}>{t("aiAdmin.bindings.goSwitch")}</Button>
        {/if}
      {/snippet}
    </AiErrorPanel>
  {/if}

  {#if !adminStore.bindings}
    <div class="flex flex-col gap-3">{#each [0, 1, 2] as i (i)}<Skeleton class="h-24" />{/each}</div>
  {:else}
    {#each sections as s (s.cap)}
      {@const all = s.roles.every(r => selected.includes(r))}
      <div class="rounded-[var(--radius-card)] border border-line/70 bg-surface shadow-card">
        <div class="flex items-center gap-3 border-b border-line px-4 py-2.5 sm:px-5">
          <CheckCircle checked={all} label={t("aiAdmin.bindings.selectAll", { section: t(s.title) })} onToggle={v => toggleAll(s.roles, v)} />
          <h2 class="text-[14.5px] font-semibold">{t(s.title)}</h2>
          {#if s.roles.length > 1}
            <button type="button" class="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink" onclick={() => openPicker(s.roles)}>
              <Link2 class="size-4" />{t("aiAdmin.bindings.bindSection")}
            </button>
          {/if}
        </div>
        <ul class="divide-y divide-line">
          {#each s.roles as role (role)}
            {@const b = binding(role)}
            {@const st = b.status}
            {@const pid = targetProvider(b)}
            <li class="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5 {selected.includes(role) ? 'bg-surface-2/60' : ''}">
              <div class="flex min-w-0 flex-1 items-start gap-3">
                <CheckCircle checked={selected.includes(role)} label={t(ROLE_KEYS[role].label)} onToggle={v => toggle(role, v)} />
                <div class="min-w-0">
                  <p class="flex flex-wrap items-center gap-x-2 text-[14.5px] font-semibold">
                    {t(ROLE_KEYS[role].label)}<span class="text-[11.5px] font-normal text-ink-3">{role}</span>
                  </p>
                  <p class="mt-0.5 text-[12.5px] text-ink-3">{t(ROLE_KEYS[role].hint)}</p>
                </div>
              </div>
              <div class="flex min-w-0 items-center gap-2 pl-11 sm:w-[min(420px,46%)] sm:pl-0">
                <button
                  type="button"
                  class="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl border px-3 text-left transition-colors hover:border-ink-3 {b.target ? 'border-line-2' : 'border-dashed border-line-2'}"
                  onclick={() => openPicker([role])}
                  aria-label={t("aiAdmin.bindings.change", { role: t(ROLE_KEYS[role].label) })}
                >
                  <StateDot state={st?.state ?? "unconfigured"} pulse />
                  {#if b.target?.type === "group"}
                    <Boxes class="size-4 shrink-0 text-ink-3" aria-hidden="true" />
                    <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium">{b.target.name}</span>
                  {:else if b.target}
                    <ProviderIcon kind={adminStore.provider(pid)?.kind} size="xs" />
                    <span class="min-w-0 flex-1 truncate font-mono text-[12.5px]">{b.target.name}</span>
                  {:else}
                    <span class="min-w-0 flex-1 truncate text-[13px] text-ink-3">{t("aiAdmin.bindings.none")}</span>
                  {/if}
                  {#if st?.detail.vision && b.target}<VisionBadge vision={true} source="model_list" />{/if}
                  <span class="shrink-0 text-[12px] text-ink-3">{t(STATE_KEYS[st?.state ?? "unconfigured"])}</span>
                </button>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
</section>

{#if selected.length}
  <div
    transition:fly={{ y: 24, duration: 160 }}
    class="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+76px)] z-30 mx-auto flex max-w-xl flex-wrap items-center gap-2 rounded-[22px] border border-line bg-surface/95 p-2 pl-4 shadow-pop backdrop-blur lg:bottom-5"
    role="region"
    aria-label={t("aiAdmin.bindings.bulkBar")}
  >
    <span class="min-w-0 flex-1 text-[13.5px]"><b>{t("aiAdmin.bindings.selected", { n: selected.length })}</b>{#if caps.length > 1}<span class="block text-[12px] text-ink-3">{t("aiAdmin.picker.mixed")}</span>{/if}</span>
    {#if busy}<Spinner class="size-4 text-ink-3" />{/if}
    <Button size="sm" variant="ghost" disabled={busy} onclick={() => apply(selected, null)}><Unlink />{t("aiAdmin.bindings.unbind")}</Button>
    <Button size="sm" variant="primary" disabled={busy || caps.length > 1} onclick={() => openPicker(selected)}><Link2 />{t("aiAdmin.bindings.bindTo")}</Button>
    <Button size="icon-sm" variant="ghost" aria-label={t("aiAdmin.bindings.clear")} onclick={() => (selected = [])}><X /></Button>
  </div>
{/if}

<TargetPicker
  bind:open={pickerOpen}
  capability={pickerCap}
  title={pickerRoles.length === 1 ? t("aiAdmin.bindings.pickOne", { role: t(ROLE_KEYS[pickerRoles[0]!].label) }) : t("aiAdmin.bindings.pickMany", { n: pickerRoles.length })}
  description={pickerRoles.length > 1 ? roleNames(pickerRoles) : undefined}
  current={currentKey}
  onPick={(target, label) => apply(pickerRoles, target, label)}
/>
