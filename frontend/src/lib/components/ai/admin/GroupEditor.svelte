<script lang="ts">
  import { tick } from "svelte";
  import { flip } from "svelte/animate";
  import { slide } from "svelte/transition";
  import { ArrowDown, ArrowLeft, ArrowUp, Boxes, ChevronDown, GripVertical, Plus, Trash2 } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type AiErrorBody, type Capability, type Group, type GroupStrategy, type ParamField, type TargetInput } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { paramsFromRaw, rawFromParams, type RawValues } from "#lib/ai/form.ts";
  import { ancestors, modelHealth, providerTone, shares } from "#lib/ai/routing.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";
  import BrickFace from "./diagram/BrickFace.svelte";
  import ParamsForm from "./ParamsForm.svelte";
  import ProfileBadges from "./ProfileBadges.svelte";
  import TargetPicker from "./TargetPicker.svelte";

  /** Group editor: strategy + a stack of bricks (models or child groups) with drag / keyboard reorder, weights and request params. */
  let { group, onClose }: { group: Group | null; onClose: (saved: boolean) => void } = $props();

  type Draft = { key: number; model_ref: string | null; child_group_id: string | null; weight: string; enabled: boolean; raw: RawValues; open: boolean };
  let seq = 0;
  // svelte-ignore state_referenced_locally
  let name = $state(group?.name ?? "");
  // svelte-ignore state_referenced_locally
  let description = $state(group?.description ?? "");
  // svelte-ignore state_referenced_locally
  let capability = $state<Capability>(group?.capability ?? "chat");
  // svelte-ignore state_referenced_locally
  let strategy = $state<GroupStrategy>(group?.strategy ?? "fallback");
  let members = $state<Draft[]>([]);
  let saving = $state(false);
  let error = $state<AiErrorBody | null>(null);
  let issues = $state<Array<{ index: number; key: string; message_zh: string }>>([]);
  let announce = $state("");
  let pickerOpen = $state(false);
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function fieldsFor(d: Draft): ParamField[] {
    const reg = adminStore.registry;
    if (!reg || !d.model_ref) return [];
    if (capability === "asr") return reg.platform_params.asr;
    const m = adminStore.model(d.model_ref);
    const vendor = (m?.provider_kind ? adminStore.entry("llm", m.provider_kind)?.params : [])?.map(f => ({ ...f, scope: "vendor" as const })) ?? [];
    const platform = capability === "embedding" ? reg.platform_params.embedding : reg.platform_params.chat;
    const taken = new Set(platform.map(f => f.key));
    return [...platform, ...vendor.filter(f => !taken.has(f.key))];
  }

  $effect.pre(() => {
    if (members.length || !group) return;
    members = group.members.map(m => {
      const d: Draft = { key: ++seq, model_ref: m.model_ref, child_group_id: m.child_group_id, weight: String(m.weight), enabled: m.enabled, raw: {}, open: false };
      d.raw = rawFromParams(fieldsFor(d), m.params ?? {});
      return d;
    });
  });

  const exclude = $derived(group ? new Set([group.id, ...ancestors(adminStore.groups, group.id)]) : new Set<string>());
  const pcts = $derived(shares(members.map(m => ({ weight: Number(m.weight) || 1, enabled: m.enabled }))));
  const setCount = (d: Draft) => Object.values(d.raw).filter(v => v !== "" && v !== undefined).length;
  const issueFor = (i: number) => issues.filter(x => x.index === i).map(x => x.message_zh);

  function add(target: TargetInput) {
    const d: Draft = { key: ++seq, model_ref: "model_id" in target ? target.model_id : null, child_group_id: "group_id" in target ? target.group_id : null, weight: "1", enabled: true, raw: {}, open: false };
    members = [...members, d];
    announce = t("aiAdmin.groups.added", { n: members.length });
  }

  let handles = $state<HTMLElement[]>([]);
  let rows = $state<HTMLElement[]>([]);
  let dragging = $state<number | null>(null);
  async function move(from: number, to: number, focus = true) {
    if (to < 0 || to >= members.length || from === to) return;
    const next = [...members];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m!);
    members = next;
    announce = t("aiAdmin.groups.moved", { n: to + 1 });
    if (focus) {
      await tick();
      handles[to]?.focus();
    }
  }
  function onPointerDown(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = i;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (dragging === null) return;
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j]?.getBoundingClientRect();
      if (!r || j === dragging) continue;
      const mid = r.top + r.height / 2;
      if ((j < dragging && e.clientY < mid) || (j > dragging && e.clientY > mid)) {
        const from = dragging;
        dragging = j;
        void move(from, j, false);
        break;
      }
    }
  }
  function onHandleKey(e: KeyboardEvent, i: number) {
    if (e.key === "ArrowUp") (e.preventDefault(), void move(i, i - 1));
    else if (e.key === "ArrowDown") (e.preventDefault(), void move(i, i + 1));
  }

  async function save() {
    saving = true;
    error = null;
    issues = [];
    const body = {
      name: name.trim(),
      description: description.trim(),
      capability,
      strategy,
      members: members.map(d =>
        d.child_group_id
          ? { child_group_id: d.child_group_id, weight: Number(d.weight) || 1, enabled: d.enabled }
          : { model_id: d.model_ref, weight: Number(d.weight) || 1, enabled: d.enabled, params: paramsFromRaw(fieldsFor(d), d.raw).params },
      ),
    };
    try {
      const r = group ? await aiApi.put<{ warnings: string[] }>(`/admin/ai/groups/${group.id}`, body) : await aiApi.post<{ warnings: string[] }>("/admin/ai/groups", body);
      toasts.show(t("aiAdmin.groups.saved", { name: body.name }), "success");
      for (const w of r.warnings ?? []) toasts.show(w, "default", 6000);
      await adminStore.reloadRouting();
      onClose(true);
    } catch (e) {
      error = toErrorBody(e);
      issues = (error.detail?.issues as typeof issues | undefined) ?? [];
    } finally {
      saving = false;
    }
  }

  const strategies: GroupStrategy[] = ["fallback", "load_balance", "round_robin"];
  const sKey = (s: GroupStrategy) => `aiAdmin.strategy.${s}` as MessageKey;
  const capKey = (c: Capability) => `aiAdmin.cap.${c}` as MessageKey;
  const seqLabel = (i: number) => (strategy === "fallback" ? String(i + 1) : strategy === "load_balance" ? `${pcts[i]}%` : "↻");
  const seqTitle = (i: number) => (strategy === "fallback" ? (i === 0 ? t("aiAdmin.groups.first") : t("aiAdmin.groups.fallbackN", { n: i })) : strategy === "load_balance" ? t("aiAdmin.groups.share", { p: pcts[i] ?? 0 }) : t("aiAdmin.groups.rotates"));
  const bound = $derived(Boolean(group?.bound_roles.length));
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={() => (dragging = null)} onpointercancel={() => (dragging = null)} />

<div class="flex flex-col gap-4">
  <div><Button variant="ghost" class="-ml-3" onclick={() => onClose(false)}><ArrowLeft />{t("aiAdmin.groups.back")}</Button></div>
  <Card>
    <h2 class="mb-4 text-[17px] font-semibold">{group ? t("aiAdmin.groups.editTitle") : t("aiAdmin.groups.newTitle")}</h2>
    <div class="grid gap-4 md:grid-cols-2">
      <TextField label="{t('aiAdmin.groups.name')} *" bind:value={name} maxlength={80} error={issues.find(i => i.key === "name")?.message_zh ?? null} />
      <TextField label={t("aiAdmin.groups.description")} bind:value={description} maxlength={500} />
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("aiAdmin.groups.capability")}</span>
        <Segmented
          value={capability}
          label={t("aiAdmin.groups.capability")}
          options={(["chat", "embedding", "asr"] as Capability[]).map(c => ({ value: c, label: t(capKey(c)) }))}
          onValueChange={v => {
            if (bound) return;
            capability = v;
            members = [];
          }}
          class="self-start"
        />
        {#if bound}<p class="text-[12px] text-ink-3">{t("aiAdmin.groups.capLocked")}</p>{/if}
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("aiAdmin.groups.strategy")}</span>
        <div class="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          <Segmented bind:value={strategy} label={t("aiAdmin.groups.strategy")} options={strategies.map(s => ({ value: s, label: t(sKey(s)) }))} class="min-w-max" />
        </div>
        <p class="text-[12.5px] text-ink-3">{t(`${sKey(strategy)}.hint` as MessageKey)}</p>
      </div>
    </div>
  </Card>

  <Card>
    <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-[15px] font-semibold">{t("aiAdmin.groups.bricks")}</h3>
      <Button size="sm" variant="secondary" onclick={() => (pickerOpen = true)}><Plus />{t("aiAdmin.groups.addBrick")}</Button>
    </div>
    <p class="mb-4 text-[12.5px] text-ink-3">{t("aiAdmin.groups.bricksHint")}</p>
    <p class="sr-only" aria-live="assertive">{announce}</p>
    {#if !members.length}
      <button type="button" onclick={() => (pickerOpen = true)} class="w-full rounded-2xl border border-dashed border-line-2 py-8 text-center text-[13px] text-ink-3 hover:border-ink-3 hover:text-ink-2">{t("aiAdmin.groups.noBricks")}</button>
    {:else}
      <ol class="baseplate flex flex-col gap-2 rounded-2xl p-2.5">
        {#each members as d, i (d.key)}
          {@const m = adminStore.model(d.model_ref)}
          {@const child = adminStore.group(d.child_group_id)}
          <li bind:this={rows[i]} animate:flip={{ duration: reduce ? 0 : 180 }} class="rounded-[14px] {dragging === i ? 'z-10' : ''}">
            <div class="flex items-start gap-1.5">
              <button
                bind:this={handles[i]}
                type="button"
                class="mt-[9px] grid h-10 w-8 shrink-0 cursor-grab touch-none place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink active:cursor-grabbing"
                aria-label={t("aiAdmin.groups.moveBrick", { n: i + 1 })}
                aria-roledescription="sortable"
                onpointerdown={e => onPointerDown(e, i)}
                onkeydown={e => onHandleKey(e, i)}><GripVertical class="size-4.5" /></button
              >
              <div class="min-w-0 flex-1">
                <BrickFace
                  tone={child ? "stone" : providerTone(m?.provider_id)}
                  title={child ? child.name : (m?.model_id ?? "?")}
                  vendor={!child && m ? { kind: m.provider_kind } : undefined}
                  subtitle={child ? `${t(sKey(child.strategy))} · ${t("aiAdmin.groups.memberCount", { n: child.members.length })}` : (m?.provider_name ?? "")}
                  mono={!child}
                  seq={seqLabel(i)}
                  seqTitle={seqTitle(i)}
                  health={m ? modelHealth(m, adminStore.providers, adminStore.bindings) : undefined}
                  dim={!d.enabled}
                  lifted={dragging === i}
                >
                  {#snippet badges()}
                    {#if child}<Boxes class="size-3.5" aria-hidden="true" />{:else if m}<ProfileBadges model={m} />{/if}
                  {/snippet}
                  {#snippet trailing()}
                    <span class="flex shrink-0 items-center gap-0.5">
                      <span class="hidden sm:inline-flex">
                        <button type="button" class="grid size-9 place-items-center rounded-full text-[var(--bi)] hover:bg-black/5 disabled:opacity-30" disabled={i === 0} aria-label={t("aiAdmin.groups.up")} onclick={() => move(i, i - 1)}><ArrowUp class="size-4" /></button>
                        <button type="button" class="grid size-9 place-items-center rounded-full text-[var(--bi)] hover:bg-black/5 disabled:opacity-30" disabled={i === members.length - 1} aria-label={t("aiAdmin.groups.down")} onclick={() => move(i, i + 1)}><ArrowDown class="size-4" /></button>
                      </span>
                      <Switch bind:checked={d.enabled} label={t("aiAdmin.groups.enabled")} />
                      <button type="button" class="grid size-10 place-items-center rounded-full text-[var(--bi)] hover:bg-black/5" aria-label={t("aiAdmin.groups.remove")} onclick={() => (members = members.filter((_, j) => j !== i))}><Trash2 class="size-4" /></button>
                    </span>
                  {/snippet}
                </BrickFace>
                {#if issueFor(i).length}<p class="mt-1 px-1 text-[12.5px] text-danger">{issueFor(i).join(" ")}</p>{/if}
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-1.5">
                  {#if strategy === "load_balance"}
                    <label class="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
                      {t("aiAdmin.groups.weight")}
                      <input type="number" min="1" max="1000" step="1" bind:value={d.weight} class="h-9 w-20 rounded-lg border border-line-2 bg-surface px-2 text-[13px] tabular-nums outline-none focus:border-ink" />
                    </label>
                  {/if}
                  {#if d.model_ref}
                    <button type="button" class="inline-flex h-9 items-center gap-1.5 rounded-lg text-[12.5px] text-ink-2 hover:text-ink" aria-expanded={d.open} onclick={() => (d.open = !d.open)}>
                      <ChevronDown class="size-4 transition-transform {d.open ? 'rotate-180' : ''}" />{t("aiAdmin.groups.params")}
                      <span class="text-ink-3">· {setCount(d) ? t("aiAdmin.routes.paramsSet", { n: setCount(d) }) : t("aiAdmin.routes.paramsNone")}</span>
                    </button>
                  {/if}
                </div>
                {#if d.open && d.model_ref}
                  <div transition:slide={{ duration: reduce ? 0 : 160 }} class="mt-1 rounded-xl bg-surface p-3">
                    <p class="mb-3 text-[12px] text-ink-3">{t("aiAdmin.groups.paramsHint")}</p>
                    <ParamsForm fields={fieldsFor(d)} bind:raw={d.raw} />
                  </div>
                {/if}
              </div>
            </div>
          </li>
        {/each}
      </ol>
    {/if}
  </Card>

  {#if error}<AiErrorPanel {error} />{/if}
  <div class="pointer-events-none sticky bottom-[calc(env(safe-area-inset-bottom)+76px)] z-10 flex justify-end gap-2 lg:bottom-4">
    <div class="pointer-events-auto flex gap-2 rounded-full border border-line bg-surface/90 p-1.5 shadow-pop backdrop-blur">
      <Button variant="ghost" onclick={() => onClose(false)}>{t("action.cancel")}</Button>
      <Button variant="primary" loading={saving} disabled={!name.trim()} onclick={save}>{t("aiAdmin.groups.save")}</Button>
    </div>
  </div>
</div>

<TargetPicker bind:open={pickerOpen} {capability} {exclude} title={t("aiAdmin.groups.addBrick")} description={t("aiAdmin.groups.addBrickHint")} onPick={target => add(target)} />

<style>
  .baseplate {
    background-color: var(--surface-2);
    background-image: radial-gradient(circle at 8px 8px, color-mix(in oklab, var(--ink-3) 18%, transparent) 2.2px, transparent 2.6px);
    background-size: 16px 16px;
  }
</style>
