<script lang="ts">
  import { tick } from "svelte";
  import { flip } from "svelte/animate";
  import { slide } from "svelte/transition";
  import { ArrowLeft, ChevronDown, GitBranch, GripVertical, Plus, Trash2 } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type AiErrorBody, type Capability, type ParamField, type Route, type Strategy } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { L, paramsFromRaw, rawFromParams, type RawValues } from "#lib/ai/form.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import ParamsForm from "./ParamsForm.svelte";
  import VisionBadge from "../../vision/VisionBadge.svelte";

  /** Inline route editor: strategy, member tree (custom drag + keyboard reorder), weights and whitelisted params. */
  let { route, capabilities, onClose }: { route: Route | null; capabilities: Capability[]; onClose: (saved: boolean) => void } = $props();

  type Draft = { key: number; kind: "model" | "child"; provider_id: string; model: string; child_route_id: string; weight: string; enabled: boolean; raw: RawValues; open: boolean };
  let seq = 0;
  const draft = (m?: Route["members"][number]): Draft => ({
    key: ++seq,
    kind: m?.child_route_id ? "child" : "model",
    provider_id: m?.provider_id ?? "",
    model: m?.model ?? "",
    child_route_id: m?.child_route_id ?? "",
    weight: String(m?.weight ?? 1),
    enabled: m?.enabled ?? true,
    raw: {},
    open: false,
  });

  // The editor is re-created per route, so initial values are intended.
  // svelte-ignore state_referenced_locally
  let name = $state(route?.name ?? "");
  // svelte-ignore state_referenced_locally
  let description = $state(route?.description ?? "");
  // svelte-ignore state_referenced_locally
  let capability = $state<Capability>(route?.capability ?? capabilities[0]!);
  // svelte-ignore state_referenced_locally
  let strategy = $state<Strategy>(route?.strategy ?? "fallback");
  let members = $state<Draft[]>([]);
  let saving = $state(false);
  let error = $state<AiErrorBody | null>(null);
  let warnings = $state<string[]>([]);
  let issues = $state<Array<{ index: number; key: string; message_zh: string }>>([]);
  let announce = $state("");
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const family = $derived(capability === "asr" ? "asr" : "llm");
  const providers = $derived(
    (adminStore.providers ?? []).filter(p => {
      if (p.family !== family) return false;
      if (family === "asr") return true;
      const caps = adminStore.entry("llm", p.kind)?.capabilities;
      return capability === "embedding" ? caps?.embeddings : caps?.chat;
    }),
  );
  const childRoutes = $derived((adminStore.routes ?? []).filter(r => r.capability === capability && r.id !== route?.id));

  function fieldsFor(d: Draft): ParamField[] {
    const reg = adminStore.registry;
    if (!reg || d.kind !== "model") return [];
    if (capability === "asr") return reg.platform_params.asr;
    const p = adminStore.providers?.find(x => x.id === d.provider_id);
    const vendor = (p ? adminStore.entry("llm", p.kind)?.params : [])?.map(f => ({ ...f, scope: "vendor" as const })) ?? [];
    const platform = capability === "embedding" ? reg.platform_params.embedding : reg.platform_params.chat;
    const taken = new Set(platform.map(f => f.key));
    return [...platform, ...vendor.filter(f => !taken.has(f.key))];
  }

  // Initial members (raw params need the registry).
  $effect.pre(() => {
    if (members.length || !route) return;
    members = route.members.map(m => {
      const d = draft(m);
      d.raw = rawFromParams(fieldsFor(d), m.params ?? {});
      return d;
    });
  });

  const setCount = (d: Draft) => Object.values(d.raw).filter(v => v !== "" && v !== undefined).length;
  const issueFor = (i: number, key: string) => issues.find(x => x.index === i && (x.key === key || x.key.startsWith(`${key}.`)))?.message_zh ?? null;

  function addModel() {
    members = [...members, draft()];
  }
  function addChild() {
    const d = draft();
    d.kind = "child";
    members = [...members, d];
  }
  function remove(i: number) {
    members = members.filter((_, j) => j !== i);
  }

  async function move(from: number, to: number, focus = true) {
    if (to < 0 || to >= members.length || from === to) return;
    const next = [...members];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m!);
    members = next;
    announce = t("aiAdmin.routes.member.moved", { n: to + 1 });
    if (focus) {
      await tick();
      handles[to]?.focus();
    }
  }

  // ---- pointer drag (handle only; works with mouse, pen and touch)
  let rows = $state<HTMLElement[]>([]);
  let handles = $state<HTMLElement[]>([]);
  let dragging = $state<number | null>(null);
  function onPointerDown(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = i;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (dragging === null) return;
    const y = e.clientY;
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j]?.getBoundingClientRect();
      if (!r || j === dragging) continue;
      const mid = r.top + r.height / 2;
      if ((j < dragging && y < mid) || (j > dragging && y > mid)) {
        const from = dragging;
        dragging = j;
        void move(from, j, false);
        break;
      }
    }
  }
  function onPointerUp() {
    dragging = null;
  }
  function onHandleKey(e: KeyboardEvent, i: number) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      void move(i, i - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      void move(i, i + 1);
    }
  }

  async function save() {
    saving = true;
    error = null;
    issues = [];
    warnings = [];
    const body = {
      name: name.trim(),
      description: description.trim(),
      capability,
      strategy,
      members: members.map(d => {
        if (d.kind === "child") return { child_route_id: d.child_route_id || null, weight: Number(d.weight) || 1, enabled: d.enabled };
        return { provider_id: d.provider_id || null, model: d.model.trim() || null, weight: Number(d.weight) || 1, enabled: d.enabled, params: paramsFromRaw(fieldsFor(d), d.raw).params };
      }),
    };
    try {
      const r = route ? await aiApi.put<{ warnings: string[] }>(`/admin/ai/routes/${route.id}`, body) : await aiApi.post<{ warnings: string[] }>("/admin/ai/routes", body);
      toasts.show(t("aiAdmin.routes.saved", { name: body.name }), "success");
      await Promise.all([adminStore.reloadRoutes(), adminStore.reloadProviders(), adminStore.reloadRoles()]);
      if (r.warnings?.length) toasts.show(r.warnings.join(" "), "default", 6000);
      onClose(true);
    } catch (e) {
      error = toErrorBody(e);
      issues = (error.detail?.issues as typeof issues | undefined) ?? [];
    } finally {
      saving = false;
    }
  }

  const strategies: Strategy[] = ["single", "fallback", "round_robin", "load_balance"];
  const strategyKey = (s: Strategy) => `aiAdmin.routes.strategy.${s}` as MessageKey;
  const capKey = (c: Capability) => `aiAdmin.cap.${c}` as MessageKey;
  const positionLabel = (i: number) => (strategy === "load_balance" ? `#${i + 1}` : i === 0 ? t("aiAdmin.routes.member.first") : t("aiAdmin.routes.member.fallbackN", { n: i }));
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp} />

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="ghost" class="-ml-3" onclick={() => onClose(false)}><ArrowLeft />{t("aiAdmin.routes.back")}</Button>
  </div>
  <Card>
    <h2 class="mb-4 text-[17px] font-semibold">{route ? t("aiAdmin.routes.editTitle") : t("aiAdmin.routes.newTitle")}</h2>
    <div class="grid gap-4 md:grid-cols-2">
      <TextField label="{t('aiAdmin.routes.name')} *" bind:value={name} maxlength={80} error={issues.find(i => i.key === "name")?.message_zh ?? null} />
      <TextField label={t("aiAdmin.routes.description")} bind:value={description} maxlength={500} />
      {#if capabilities.length > 1}
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("aiAdmin.routes.capability")}</span>
          <Segmented
            value={capability}
            label={t("aiAdmin.routes.capability")}
            options={capabilities.map(c => ({ value: c, label: t(capKey(c)) }))}
            onValueChange={v => {
              if (route?.bound_roles.length) return;
              capability = v;
              members = [];
            }}
            class="self-start"
          />
        </div>
      {/if}
      <div class="flex flex-col gap-1.5 {capabilities.length > 1 ? '' : 'md:col-span-2'}">
        <span class="text-[13px] font-medium text-ink-2">{t("aiAdmin.routes.strategy")}</span>
        <div class="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          <Segmented bind:value={strategy} label={t("aiAdmin.routes.strategy")} options={strategies.map(s => ({ value: s, label: t(strategyKey(s)) }))} class="min-w-max" />
        </div>
        <p class="text-[12.5px] text-ink-3">{t(`${strategyKey(strategy)}.hint` as MessageKey)}</p>
      </div>
    </div>
  </Card>

  <Card>
    <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-[15px] font-semibold">{t("aiAdmin.routes.members")}</h3>
      <div class="flex gap-2">
        <Button size="sm" variant="secondary" onclick={addModel} disabled={!providers.length}><Plus />{t("aiAdmin.routes.addModel")}</Button>
        <Button size="sm" variant="ghost" onclick={addChild} disabled={!childRoutes.length}><GitBranch />{t("aiAdmin.routes.addChild")}</Button>
      </div>
    </div>
    <p class="mb-4 text-[12.5px] text-ink-3">{providers.length ? t("aiAdmin.routes.membersHint") : t("aiAdmin.routes.needProvider")}</p>
    <p class="sr-only" aria-live="assertive">{announce}</p>

    {#if !members.length}
      <p class="rounded-2xl border border-dashed border-line-2 py-8 text-center text-[13px] text-ink-3">{t("aiAdmin.routes.noMembers")}</p>
    {:else}
      <ol class="flex flex-col gap-2.5">
        {#each members as d, i (d.key)}
          {@const provider = adminStore.providers?.find(p => p.id === d.provider_id) ?? null}
          <li
            bind:this={rows[i]}
            animate:flip={{ duration: reduce ? 0 : 180 }}
            class="rounded-2xl border bg-surface transition-shadow {dragging === i ? 'border-ink-3 shadow-pop' : 'border-line'} {d.enabled ? '' : 'opacity-60'}"
          >
            <div class="flex items-start gap-2 p-3">
              <button
                bind:this={handles[i]}
                type="button"
                class="mt-0.5 grid h-10 w-8 shrink-0 cursor-grab touch-none place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink active:cursor-grabbing"
                aria-label={t("aiAdmin.routes.member.move", { n: i + 1 })}
                aria-roledescription="sortable"
                onpointerdown={e => onPointerDown(e, i)}
                onkeydown={e => onHandleKey(e, i)}
              >
                <GripVertical class="size-4.5" />
              </button>
              <div class="min-w-0 flex-1">
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <span class="rounded-full px-2 py-0.5 text-[11.5px] font-semibold {i === 0 && strategy !== 'load_balance' ? 'bg-ink text-primary-ink' : 'bg-surface-3 text-ink-2'}">{positionLabel(i)}</span>
                  {#if d.kind === "child"}<span class="inline-flex items-center gap-1 text-[12px] text-ink-3"><GitBranch class="size-3.5" />{t("aiAdmin.routes.member.child")}</span>{/if}
                  {#if d.kind === "model" && capability === "chat"}<VisionBadge providerId={d.provider_id} model={d.model} override={String(d.raw.vision ?? "")} />{/if}
                  <div class="ml-auto flex items-center gap-1">
                    <Switch bind:checked={d.enabled} label={t("aiAdmin.routes.member.enabled")} />
                    <button type="button" class="grid size-10 place-items-center rounded-full text-ink-3 hover:bg-danger-soft hover:text-danger" aria-label={t("aiAdmin.routes.member.remove")} onclick={() => remove(i)}>
                      <Trash2 class="size-4" />
                    </button>
                  </div>
                </div>
                {#if d.kind === "child"}
                  <div class="flex flex-col gap-1.5">
                    <span class="text-[13px] font-medium text-ink-2">{t("aiAdmin.routes.member.child")}</span>
                    <Select
                      value={d.child_route_id}
                      label={t("aiAdmin.routes.member.child")}
                      class="w-full"
                      options={[{ value: "", label: t("aiAdmin.routes.member.pickChild") }, ...childRoutes.map(r => ({ value: r.id, label: r.name }))]}
                      onValueChange={v => (d.child_route_id = v)}
                    />
                    {#if issueFor(i, "child_route_id")}<p class="text-[12.5px] text-danger">{issueFor(i, "child_route_id")}</p>{/if}
                  </div>
                {:else}
                  <div class="grid gap-3 sm:grid-cols-2">
                    <div class="flex min-w-0 flex-col gap-1.5">
                      <span class="text-[13px] font-medium text-ink-2">{t("aiAdmin.routes.member.provider")}</span>
                      <Select
                        value={d.provider_id}
                        label={t("aiAdmin.routes.member.provider")}
                        class="w-full min-w-0"
                        options={[{ value: "", label: t("aiAdmin.routes.member.pickProvider") }, ...providers.map(p => ({ value: p.id, label: p.name, hint: L(p.label) }))]}
                        onValueChange={v => {
                          d.provider_id = v;
                          d.raw = {};
                          const e = adminStore.providers?.find(p => p.id === v);
                          const def = e ? adminStore.entry(e.family, e.kind)?.defaultModel : undefined;
                          if (!d.model && def) d.model = def;
                        }}
                      />
                      {#if issueFor(i, "provider_id")}<p class="text-[12.5px] text-danger">{issueFor(i, "provider_id")}</p>{/if}
                    </div>
                    <ModelPicker bind:value={d.model} {provider} label={t("aiAdmin.routes.member.model")} error={issueFor(i, "model")} />
                  </div>
                {/if}
                {#if strategy === "load_balance"}
                  <TextField class="mt-3 max-w-40" label={t("aiAdmin.routes.member.weight")} type="number" min="1" max="1000" step="1" bind:value={d.weight} />
                {/if}
                {#if d.kind === "model"}
                  <button
                    type="button"
                    class="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg px-1 text-[13px] text-ink-2 hover:text-ink"
                    aria-expanded={d.open}
                    onclick={() => (d.open = !d.open)}
                  >
                    <ChevronDown class="size-4 transition-transform {d.open ? 'rotate-180' : ''}" />{t("aiAdmin.routes.params")}
                    <span class="text-ink-3">· {setCount(d) ? t("aiAdmin.routes.paramsSet", { n: setCount(d) }) : t("aiAdmin.routes.paramsNone")}</span>
                  </button>
                  {#if issues.some(x => x.index === i && x.key.startsWith("params."))}
                    <p class="text-[12.5px] text-danger">{issues.filter(x => x.index === i && x.key.startsWith("params.")).map(x => x.message_zh).join(" ")}</p>
                  {/if}
                  {#if d.open}
                    <div transition:slide={{ duration: reduce ? 0 : 160 }} class="mt-2 rounded-xl bg-surface-2 p-3">
                      <ParamsForm fields={fieldsFor(d)} bind:raw={d.raw} />
                    </div>
                  {/if}
                {/if}
              </div>
            </div>
          </li>
        {/each}
      </ol>
    {/if}
  </Card>

  {#if error}<AiErrorPanel {error} />{/if}
  {#each warnings as w (w)}<p class="text-[13px] text-ink-3">{w}</p>{/each}
  <div class="pointer-events-none sticky bottom-[calc(env(safe-area-inset-bottom)+76px)] z-10 flex justify-end gap-2 lg:bottom-4">
    <div class="pointer-events-auto flex gap-2 rounded-full border border-line bg-surface/90 p-1.5 shadow-pop backdrop-blur">
      <Button variant="ghost" onclick={() => onClose(false)}>{t("action.cancel")}</Button>
      <Button variant="primary" loading={saving} disabled={!name.trim()} onclick={save}>{t("aiAdmin.routes.save")}</Button>
    </div>
  </div>
</div>
