<script lang="ts">
  import { Activity } from "@lucide/svelte";
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import { aiApi, ROLE_KEYS, STATE_KEYS, toErrorBody, type AiErrorBody, type Capability, type RoleBinding, type RoleStatusDetail } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { aiStatus, type AiRole } from "#lib/ai/status.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";
  import StateDot from "../StateDot.svelte";
  import VisionBadge from "../../vision/VisionBadge.svelte";

  let { roles, title, onSwitchWizard }: { roles: AiRole[]; title?: string; onSwitchWizard?: () => void } = $props();
  const CAP: Record<AiRole, Capability> = { assistant: "chat", writing: "chat", slides: "chat", analysis: "chat", fast: "chat", embedding: "embedding", asr: "asr", asr_live: "asr" };

  const bindings = $derived(roles.map(role => adminStore.roles?.find(b => b.role === role) ?? ({ role, route_id: null, status: null } as RoleBinding)));
  let busy = $state<AiRole | null>(null);
  let errors = $state<Partial<Record<AiRole, AiErrorBody>>>({});
  let probing = $state(false);

  async function bind(role: AiRole, routeId: string) {
    busy = role;
    errors = { ...errors, [role]: undefined };
    try {
      await aiApi.put(`/admin/ai/roles/${role}`, { route_id: routeId || null });
      toasts.show(t("aiAdmin.bindings.saved", { role: t(ROLE_KEYS[role].label) }), "success");
      await Promise.all([adminStore.reloadRoles(), adminStore.reloadRoutes()]);
      void aiStatus.refresh();
    } catch (e) {
      errors = { ...errors, [role]: toErrorBody(e) };
      await adminStore.reloadRoles();
    } finally {
      busy = null;
    }
  }

  async function probe() {
    probing = true;
    try {
      await aiApi.post("/admin/ai/health/probe");
      await adminStore.reloadRoles();
      void aiStatus.refresh();
      toasts.show(t("aiAdmin.bindings.probed"), "success");
    } catch (e) {
      toasts.show(toErrorBody(e).error, "error");
    } finally {
      probing = false;
    }
  }

  const routeOptions = (cap: Capability) => [
    { value: "", label: t("aiAdmin.bindings.none") },
    ...(adminStore.routes ?? []).filter(r => r.capability === cap).map(r => ({ value: r.id, label: r.name, hint: t("aiAdmin.routes.memberCount", { n: r.members.length }) })),
  ];
  const roleState = (s: RoleStatusDetail | null) => s?.state ?? "unconfigured";
  const memberKey = (h: "up" | "down" | "unknown") => `aiAdmin.bindings.member.${h}` as MessageKey;
</script>

<section class="flex flex-col gap-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      {#if title}<h2 class="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>{/if}
      <p class="mt-0.5 text-[13px] text-ink-3">{t("aiAdmin.bindings.hint")}</p>
    </div>
    <Button variant="secondary" loading={probing} onclick={probe}><Activity />{t("aiAdmin.bindings.probeNow")}</Button>
  </div>

  {#if !adminStore.roles}
    <div class="flex flex-col gap-3">{#each roles as r (r)}<Skeleton class="h-24" />{/each}</div>
  {:else}
    <ul class="flex flex-col gap-3">
      {#each bindings as b (b.role)}
        {@const st = b.status}
        {@const opts = routeOptions(CAP[b.role])}
        <li class="rounded-[var(--radius-card)] border border-line/70 bg-surface p-4 shadow-card sm:p-5">
          <div class="flex flex-col gap-3 md:flex-row md:items-center md:gap-6">
            <div class="flex min-w-0 flex-1 items-start gap-3">
              <StateDot state={roleState(st)} pulse class="mt-1.5" />
              <div class="min-w-0">
                <p class="flex flex-wrap items-center gap-x-2 text-[15px] font-semibold">
                  {t(ROLE_KEYS[b.role].label)}
                  <span class="font-mono text-[11.5px] font-normal text-ink-3">{b.role}</span>
                  {#if st?.detail.vision && b.route_id}<span title={t("vision.roleHint")}><VisionBadge vision={true} source="model_list" /></span>{/if}
                </p>
                <p class="mt-0.5 text-[12.5px] text-ink-3">{t(ROLE_KEYS[b.role].hint)}</p>
              </div>
            </div>
            <div class="flex items-center gap-2 md:w-[min(340px,40%)]">
              <Select value={b.route_id ?? ""} label={t(ROLE_KEYS[b.role].label)} options={opts} class="w-full" onValueChange={v => bind(b.role, v)} />
              {#if busy === b.role}<Spinner class="size-4 shrink-0 text-ink-3" />{/if}
            </div>
          </div>
          {#if opts.length === 1}
            <p class="mt-3 text-[12.5px] text-ink-3">{t("aiAdmin.bindings.noRoutes", { cap: t(`aiAdmin.cap.${CAP[b.role]}` as MessageKey) })}</p>
          {/if}
          {#if st && b.route_id}
            <div class="mt-3 rounded-xl bg-surface-2 px-3.5 py-2.5">
              <p class="text-[12.5px] text-ink-2"><span class="font-medium">{t(STATE_KEYS[st.state])}</span>{#if st.state !== "ok" || i18n.locale === "zh-TW"} · {st.message_zh}{/if}</p>
              {#if st.detail.members?.length}
                <ul class="mt-2 flex flex-wrap gap-1.5">
                  {#each st.detail.members as m, i (m.memberId)}
                    <li
                      class="inline-flex max-w-full items-center gap-1.5 truncate rounded-lg border px-2 py-1 text-[12px] {st.detail.activeIndex === i ? 'border-ink-3 bg-surface' : 'border-line'}"
                      title="{m.providerName} / {m.model} · {t(memberKey(m.health))}{m.reason ? ` (${m.reason})` : ''}"
                    >
                      <StateDot state={m.health} />
                      <span class="truncate text-ink-3">{m.providerName}</span>
                      <span class="truncate font-mono text-[11.5px]">{m.model}</span>
                      {#if m.reason}<span class="text-ink-3">· {m.reason}</span>{/if}
                      {#if m.vision}<VisionBadge vision={true} source={m.vision_source} />{/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
          {#if errors[b.role]}
            <AiErrorPanel class="mt-3" compact error={errors[b.role]!}>
              {#snippet actions()}
                {#if errors[b.role]?.code === "embedding_model_change_requires_switch" && onSwitchWizard}
                  <Button size="sm" variant="primary" onclick={onSwitchWizard}>{t("aiAdmin.bindings.goSwitch")}</Button>
                {/if}
              {/snippet}
            </AiErrorPanel>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
