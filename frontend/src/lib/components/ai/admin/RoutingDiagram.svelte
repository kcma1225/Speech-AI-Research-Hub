<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { DropdownMenu } from "bits-ui";
  import { ArrowDown, Boxes, ChevronsDownUp, ChevronsUpDown, Ellipsis, Eye, FolderInput, Link2, Maximize, RefreshCw, Search, Unlink, ZoomIn, ZoomOut } from "@lucide/svelte";
  import { formatDate, i18n, relativeTime, t } from "#lib/i18n.svelte.ts";
  import { ROLE_KEYS, STATE_KEYS, toErrorBody, type Group, type ModelProfile, type Provider, type TargetInput } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { LivePoller } from "#lib/ai/live-poll.ts";
  import { L } from "#lib/ai/form.ts";
  import { dot, descendants, diagramRows, modelHealth, ms, pct, providerHealth, providersOf, providerTone, ROLE_CAP, ROLE_ORDER, stateTone, statFor, targetKey, type TargetKey } from "#lib/ai/routing.ts";
  import { aiStatus, type AiRole } from "#lib/ai/status.svelte.ts";
  import { menuContent, menuItem, menuLabel } from "#lib/components/ui/menu.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import StateDot from "../StateDot.svelte";
  import ProfileBadges from "./ProfileBadges.svelte";
  import ProviderIcon from "../ProviderIcon.svelte";
  import ProviderSections, { type ProviderSection } from "./ProviderSections.svelte";
  import TargetPicker from "./TargetPicker.svelte";
  import BrickFace from "./diagram/BrickFace.svelte";
  import GroupStack, { type StackActions } from "./diagram/GroupStack.svelte";
  import { DragController, type DragItem, type DropTarget } from "./diagram/dnd.svelte.ts";
  import RoleLive from "./diagram/RoleLive.svelte";
  import { pulseOnChange, recentlyUsed } from "./diagram/live.ts";

  /**
   * 總覽: the whole routing configuration as a left-to-right LEGO flow — functions → bound model or group
   * (stacked bricks; nested groups are nested plates) → provider accounts. Drag bricks to reorder or move them,
   * drop a model or group on a function to bind it; every drag has a menu/keyboard equivalent. Phones get a
   * vertical stack per target instead of the canvas.
   *
   * Live: every panel edits through `adminStore`, so changes elsewhere show here at once; while `active` (the
   * 總覽 tab is shown) and the page is visible it polls the overview version every 12 s and on each AI status push,
   * refetching only what changed. Zoom, pan and open sections are local state and survive refreshes.
   */
  let { onEditGroup, active = true }: { onEditGroup?: (groupId: string) => void; active?: boolean } = $props();

  const groupsById = $derived(new Map((adminStore.groups ?? []).map(g => [g.id, g])));
  const layout = $derived(diagramRows(adminStore.bindings));
  const roleOrder = $derived([...layout.rows.flatMap(r => r.roles), ...layout.unbound]);
  const usedProviders = $derived([...new Set(layout.rows.flatMap(r => providersOf(r.key, adminStore.groups, adminStore.models)))]);
  const providerList = $derived.by(() => {
    const all = adminStore.providers ?? [];
    return [...usedProviders.map(id => all.find(p => p.id === id)).filter((p): p is Provider => Boolean(p)), ...all.filter(p => !usedProviders.includes(p.id))];
  });
  const roleStat = (role: AiRole) => adminStore.stats?.roles.find(r => r.role === role);

  // ---------------------------------------------------------------- actions (shared by drag, menus, keyboard)

  let busy = $state(false);
  let announce = $state("");
  async function run(fn: () => Promise<unknown>, done: string) {
    busy = true;
    try {
      await fn();
      announce = done;
      toasts.show(done, "success");
      void aiStatus.refresh();
    } catch (e) {
      const err = toErrorBody(e);
      toasts.show(`${err.error}${err.hint ? ` ${err.hint}` : ""}`, "error", 7000);
    } finally {
      busy = false;
    }
  }
  const plain = (g: Group) => g.members.map(m => ({ model_ref: m.model_ref, child_group_id: m.child_group_id, weight: m.weight, params: m.params, enabled: m.enabled }));
  const labelOfMember = (g: Group, i: number) => adminStore.model(g.members[i]?.model_ref)?.model_id ?? adminStore.group(g.members[i]?.child_group_id)?.name ?? "";
  const roleName = (r: AiRole) => t(ROLE_KEYS[r].label);

  const bindRole = (role: AiRole, target: TargetInput, label: string) => run(() => adminStore.bind([role], target), t("aiAdmin.bindings.boundMany", { roles: roleName(role), target: label }));
  const unbindRole = (role: AiRole) => run(() => adminStore.bind([role], null), t("aiAdmin.bindings.unboundMany", { roles: roleName(role) }));

  function insert(groupId: string, index: number, member: ReturnType<typeof plain>[number], label: string) {
    const g = groupsById.get(groupId);
    if (!g) return;
    const list = plain(g);
    list.splice(Math.min(index, list.length), 0, member);
    return run(() => adminStore.saveGroup(g, list), t("aiAdmin.diagram.added", { name: label, group: g.name }));
  }

  /** Moves a member between groups as one optimistic step (both plates change at once, both roll back on error). */
  function moveAcross(src: Group, index: number, dst: Group, at: number, label: string) {
    const m = plain(src)[index];
    if (!m) return;
    const list = plain(dst);
    list.splice(Math.min(at, list.length), 0, m);
    const rest = plain(src);
    rest.splice(index, 1);
    return run(
      () =>
        adminStore.mutate(
          () => (adminStore.localMembers(dst.id, list), adminStore.localMembers(src.id, rest)),
          async () => {
            await adminStore.putGroup(dst, list, false);
            await adminStore.putGroup(src, rest);
          },
        ),
      t("aiAdmin.diagram.movedTo", { name: label, group: dst.name }),
    );
  }

  const actions: StackActions = {
    move(groupId, from, to) {
      const g = groupsById.get(groupId);
      if (!g || to < 0 || to >= g.members.length) return;
      const list = plain(g);
      const [m] = list.splice(from, 1);
      list.splice(to, 0, m!);
      void run(() => adminStore.saveGroup(g, list), t("aiAdmin.diagram.moved", { name: labelOfMember(g, from), n: to + 1 }));
    },
    moveTo(groupId, index, toGroupId) {
      const from = groupsById.get(groupId);
      const to = groupsById.get(toGroupId);
      if (!from || !to) return;
      void moveAcross(from, index, to, to.members.length, labelOfMember(from, index));
    },
    remove(groupId, index) {
      const g = groupsById.get(groupId);
      if (!g) return;
      const list = plain(g);
      list.splice(index, 1);
      void run(() => adminStore.saveGroup(g, list), t("aiAdmin.diagram.removed", { name: labelOfMember(g, index), group: g.name }));
    },
    bind(groupId, index, role) {
      const m = groupsById.get(groupId)?.members[index];
      if (!m) return;
      if (m.model_ref) void bindRole(role, { model_id: m.model_ref }, adminStore.model(m.model_ref)?.model_id ?? "");
      else if (m.child_group_id) void bindRole(role, { group_id: m.child_group_id }, adminStore.group(m.child_group_id)?.name ?? "");
    },
    edit: id => onEditGroup?.(id),
  };

  // ---------------------------------------------------------------- drag and drop

  function accept(item: DragItem, target: DropTarget): boolean {
    if (target.kind === "role") return ROLE_CAP[target.role] === item.capability;
    const g = groupsById.get(target.groupId);
    if (!g || g.capability !== item.capability) return false;
    const childId = item.kind === "group" ? item.groupId : item.kind === "member" ? item.childGroupId : null;
    if (childId && descendants(adminStore.groups, childId).has(target.groupId)) return false;
    return true;
  }
  function drop(item: DragItem, target: DropTarget) {
    if (target.kind === "role") {
      if (item.kind === "model") return void bindRole(target.role, { model_id: item.modelId }, item.label);
      if (item.kind === "group") return void bindRole(target.role, { group_id: item.groupId }, item.label);
      if (item.modelRef) return void bindRole(target.role, { model_id: item.modelRef }, item.label);
      if (item.childGroupId) return void bindRole(target.role, { group_id: item.childGroupId }, item.label);
      return;
    }
    if (item.kind === "model") return void insert(target.groupId, target.index, { model_ref: item.modelId, child_group_id: null, weight: 1, params: {}, enabled: true }, item.label);
    if (item.kind === "group") return void insert(target.groupId, target.index, { model_ref: null, child_group_id: item.groupId, weight: 1, params: {}, enabled: true }, item.label);
    if (item.groupId === target.groupId) {
      const to = target.index > item.index ? target.index - 1 : target.index;
      if (to !== item.index) actions.move(item.groupId, item.index, to);
      return;
    }
    const src = groupsById.get(item.groupId);
    const dst = groupsById.get(target.groupId);
    if (!src || !dst) return;
    void moveAcross(src, item.index, dst, target.index, item.label);
  }
  const dnd = new DragController(accept, drop);

  // ---------------------------------------------------------------- canvas: zoom, pan, connectors

  let viewport = $state<HTMLElement | null>(null);
  let content = $state<HTMLElement | null>(null);
  let scale = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let size = $state({ w: 0, h: 0 });
  type Line = { d: string; color: string; role?: AiRole; key?: TargetKey; provider?: string; model?: string; kind: "role" | "provider" };
  let lines = $state<Line[]>([]);
  let focusRole = $state<AiRole | null>(null);
  let focusKey = $state<TargetKey | null>(null);

  const clampScale = (s: number) => Math.min(1.6, Math.max(0.4, Math.round(s * 100) / 100));
  function zoom(delta: number) {
    scale = clampScale(scale + delta);
  }
  function fit() {
    if (!viewport || !content) return;
    const vw = viewport.clientWidth - 24;
    scale = clampScale(Math.min(1, vw / Math.max(1, size.w)));
    panX = Math.max(12, (viewport.clientWidth - size.w * scale) / 2);
    panY = 12;
  }

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(40, (x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  };
  function measure() {
    if (!content) return;
    const base = content.getBoundingClientRect();
    const s = scale || 1;
    const rel = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { l: (r.left - base.left) / s, t: (r.top - base.top) / s, r: (r.right - base.left) / s, b: (r.bottom - base.top) / s };
    };
    size = { w: content.scrollWidth, h: content.scrollHeight };
    const out: Line[] = [];
    for (const b of adminStore.bindings ?? []) {
      const key = targetKey(b);
      const roleEl = content.querySelector(`[data-role-node="${b.role}"]`);
      const tgtEl = key ? content.querySelector(`[data-target-key="${key}"]`) : null;
      if (!roleEl || !tgtEl || !key) continue;
      const a = rel(roleEl);
      const z = rel(tgtEl);
      out.push({ kind: "role", role: b.role, key, d: curve(a.r, (a.t + a.b) / 2, z.l, Math.min(z.t + 26, (z.t + z.b) / 2)), color: stateTone(b.status?.state) });
    }
    for (const tgtEl of content.querySelectorAll<HTMLElement>("[data-target-key]")) {
      const key = tgtEl.dataset.targetKey as TargetKey;
      const z = rel(tgtEl);
      for (const leaf of tgtEl.querySelectorAll<HTMLElement>("[data-leaf-provider]")) {
        const pid = leaf.dataset.leafProvider;
        const mid = leaf.dataset.leafModel;
        const pEl = pid ? content.querySelector(`[data-provider-id="${pid}"]`) : null;
        if (!pEl || !pid) continue;
        const l = rel(leaf);
        const p = rel(pEl);
        out.push({ kind: "provider", key, provider: pid, model: mid, d: curve(z.r, (l.t + l.b) / 2, p.l, (p.t + p.b) / 2), color: `var(--pill-${providerTone(pid)}-ink)` });
      }
    }
    lines = out;
    if (!fitted && size.w && viewport?.clientWidth) {
      fitted = true;
      fit();
    }
  }
  let raf = 0;
  let fitted = false;
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(measure);
  };
  $effect(() => {
    void adminStore.bindings;
    void adminStore.groups;
    void adminStore.models;
    void adminStore.stats;
    void adminStore.providers;
    void i18n.locale;
    void active;
    void tick().then(schedule);
  });
  // The canvas only exists once data has loaded, so observe it when it appears (not on mount).
  $effect(() => {
    const c = content;
    const v = viewport;
    if (!c || !v) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(c);
    ro.observe(v);
    void document.fonts?.ready.then(schedule);
    // Ctrl/⌘ + wheel zooms; needs a non-passive listener to keep the page from zooming.
    const wheel = (e: WheelEvent) => onWheel(e);
    v.addEventListener("wheel", wheel, { passive: false });
    return () => (ro.disconnect(), v.removeEventListener("wheel", wheel));
  });
  onMount(() => () => cancelAnimationFrame(raf));

  // ---------------------------------------------------------------- live refresh

  const POLL_MS = 12_000;
  let now = $state(Date.now());
  let visible = $state(typeof document === "undefined" || !document.hidden);
  const poller = new LivePoller(() => adminStore.sync(), { interval: POLL_MS, active: () => active });
  $effect(() => {
    if (!active) return;
    const stop = poller.start();
    untrack(() => void poller.kick());
    now = Date.now();
    const clock = setInterval(() => (now = Date.now()), 5_000);
    return () => (stop(), clearInterval(clock));
  });
  onMount(() => {
    const unwatch = aiStatus.watch();
    const onVis = () => (visible = !document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => (unwatch(), document.removeEventListener("visibilitychange", onVis));
  });
  // Health pushes (AI status SSE): refresh at once instead of waiting for the next poll.
  let lastPush: string | null | undefined;
  $effect(() => {
    const at = aiStatus.updatedAt;
    if (lastPush !== undefined && at !== lastPush) untrack(() => void poller.kick());
    lastPush = at;
  });
  const syncedLabel = $derived(adminStore.syncedAt ? formatDate(new Date(adminStore.syncedAt).toISOString(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : null);
  const liveState = $derived(adminStore.syncFailed ? "failed" : !visible || !active ? "paused" : adminStore.syncedAt ? "live" : "connecting");
  const LIVE_TITLE = { failed: "aiAdmin.live.failed", paused: "aiAdmin.live.paused", live: "aiAdmin.live.live", connecting: "aiAdmin.live.connecting" } as const;
  /** Connector animation: the route carried traffic in the last minute. */
  function flowing(l: Line) {
    if (l.kind === "role") return l.role ? recentlyUsed(roleStat(l.role)?.last_used, now) : false;
    const m = adminStore.model(l.model);
    return m ? recentlyUsed(statFor(adminStore.stats?.models, m)?.last_used, now) : false;
  }

  let panning = $state<{ x: number; y: number; px: number; py: number } | null>(null);
  function onViewportDown(e: PointerEvent) {
    if (e.button !== 0 || !(e.target as HTMLElement).closest("[data-pan]") || (e.target as HTMLElement).closest("[data-pan-stop]")) return;
    panning = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onViewportMove(e: PointerEvent) {
    if (!panning) return;
    panX = panning.px + e.clientX - panning.x;
    panY = panning.py + e.clientY - panning.y;
  }
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 0.1 : -0.1);
  }
  function onViewportKey(e: KeyboardEvent) {
    if (e.target !== viewport) return;
    const step = 40;
    if (e.key === "+" || e.key === "=") zoom(0.1);
    else if (e.key === "-") zoom(-0.1);
    else if (e.key === "0") fit();
    else if (e.key === "ArrowLeft") panX += step;
    else if (e.key === "ArrowRight") panX -= step;
    else if (e.key === "ArrowUp") panY += step;
    else if (e.key === "ArrowDown") panY -= step;
    else return;
    e.preventDefault();
  }
  const viewportH = $derived(Math.max(380, Math.min(size.h * scale + 40, 860)));
  const dimmed = (l: Line) => (focusRole ? (l.kind === "role" ? l.role !== focusRole : l.key !== keyOfRole(focusRole)) : focusKey ? l.key !== focusKey : false);
  const keyOfRole = (r: AiRole) => {
    const b = adminStore.binding(r);
    return b ? targetKey(b) : null;
  };

  // ---------------------------------------------------------------- picker + palette

  let pickerOpen = $state(false);
  let pickerRole = $state<AiRole | null>(null);
  const openPicker = (r: AiRole) => ((pickerRole = r), (pickerOpen = true));
  let paletteQuery = $state("");
  let paletteSections = $state<{ setAll: (open: boolean) => void } | null>(null);
  let paletteAllOpen = $state(false);
  const palette = $derived.by(() => {
    const q = paletteQuery.trim().toLowerCase();
    return (adminStore.models ?? []).filter(m => m.enabled && (!q || m.model_id.toLowerCase().includes(q))).sort((a, b) => b.used_by.length - a.used_by.length || a.model_id.localeCompare(b.model_id));
  });
  // Palette grouped by account (accounts in use first), each a collapsible section.
  const paletteSectionsData = $derived.by(() => {
    const out: ProviderSection<ModelProfile>[] = [];
    for (const p of providerList) {
      const items = palette.filter(m => m.provider_id === p.id);
      if (items.length) out.push({ id: p.id, name: p.name, kind: p.kind, vendor: L(p.label), health: providerHealth(p), items });
    }
    return out;
  });
  const groupsFor = (cap: string) => (adminStore.groups ?? []).filter(g => g.capability === cap);
  const rolesFor = (cap: string) => ROLE_ORDER.filter(r => ROLE_CAP[r] === cap);
  const rowFor = (role: AiRole) => layout.rows.find(r => r.roles.includes(role));
  const modelOf = (key: TargetKey) => (key.startsWith("model:") ? adminStore.model(key.slice(6)) : undefined);
  const groupOf = (key: TargetKey) => (key.startsWith("group:") ? groupsById.get(key.slice(6)) : undefined);
  const live = (m: ModelProfile) => {
    void now;
    const s = statFor(adminStore.stats?.models, m);
    return s ? `${ms(s.p50_ms)} · ${pct(s.success_rate)}${s.last_used ? ` · ${relativeTime(s.last_used)}` : ""}` : (m.provider_name ?? "");
  };
</script>

<svelte:window onpointermove={dnd.move} onpointerup={dnd.up} onpointercancel={dnd.cancel} onkeydown={dnd.key} />

{#snippet modelMenu(m: ModelProfile, role?: AiRole)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger aria-label={t("aiAdmin.diagram.brickMenu", { name: m.model_id })} class="-mr-1 grid size-9 shrink-0 place-items-center rounded-full text-[var(--bi)] hover:bg-black/5 data-[state=open]:bg-black/5">
      <Ellipsis class="size-4" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={6} class={menuContent}>
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger class={menuItem}><Link2 />{t("aiAdmin.diagram.bindTo")}</DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent class={menuContent} sideOffset={4}>
            {#each rolesFor(m.fields.capability) as r (r)}
              <DropdownMenu.Item class={menuItem} onSelect={() => bindRole(r, { model_id: m.id }, m.model_id)}>{roleName(r)}</DropdownMenu.Item>
            {/each}
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
        {#if groupsFor(m.fields.capability).length}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger class={menuItem}><FolderInput />{t("aiAdmin.diagram.addToGroup")}</DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent class={menuContent} sideOffset={4}>
              {#each groupsFor(m.fields.capability) as g (g.id)}
                <DropdownMenu.Item class={menuItem} onSelect={() => insert(g.id, g.members.length, { model_ref: m.id, child_group_id: null, weight: 1, params: {}, enabled: true }, m.model_id)}><Boxes />{g.name}</DropdownMenu.Item>
              {/each}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        {/if}
        {#if role}
          <DropdownMenu.Item class={menuItem} onSelect={() => unbindRole(role)}><Unlink />{t("aiAdmin.diagram.unbind", { role: roleName(role) })}</DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/snippet}

{#snippet roleBlock(role: AiRole, mobile: boolean)}
  {@const b = adminStore.binding(role)}
  {@const st = b?.status}
  {@const rs = roleStat(role)}
  {@const isOver = dnd.isOver({ kind: "role", role })}
  <div
    data-role-node={mobile ? undefined : role}
    data-drop="role"
    data-role={role}
    data-pan-stop
    role="group"
    aria-label={roleName(role)}
    onpointerenter={() => (focusRole = role)}
    onpointerleave={() => (focusRole = null)}
    use:pulseOnChange={`${rs?.calls ?? 0}|${st?.state ?? ""}`}
    class="role relative flex min-h-[60px] items-center gap-2.5 rounded-[16px] border bg-surface px-3 py-2 shadow-card transition-colors {b?.target ? 'border-line' : 'border-dashed border-line-2'} {isOver ? (dnd.valid ? 'border-ink ring-2 ring-ink/15' : 'border-danger') : ''}"
  >
    <StateDot state={st?.state ?? "unconfigured"} pulse />
    <div class="min-w-0 flex-1">
      <p class="truncate text-[13.5px] font-semibold">{roleName(role)}</p>
      <p class="truncate text-[11.5px] text-ink-3">
        {#if !b?.target}{t(mobile ? "aiAdmin.diagram.tapToBind" : "aiAdmin.diagram.dropHere")}
        {:else if rs}<RoleLive stat={rs} {now} />
        {:else}{t(STATE_KEYS[st?.state ?? "unconfigured"])}{/if}
      </p>
    </div>
    {#if st?.detail.vision && b?.target}<span class="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--pill-sky)] text-[var(--pill-sky-ink)]" title={t("vision.roleHint")}><Eye class="size-3.5" aria-hidden="true" /><span class="sr-only">{t("vision.badge")}</span></span>{/if}
    <button type="button" class="-mr-1 grid size-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("aiAdmin.bindings.change", { role: roleName(role) })} onclick={() => openPicker(role)}>
      <Link2 class="size-4" />
    </button>
  </div>
{/snippet}

{#snippet targetBlock(key: TargetKey, roles: AiRole[], mobile: boolean)}
  {@const m = modelOf(key)}
  {@const g = groupOf(key)}
  <div role="group" aria-label={g?.name ?? m?.model_id ?? ""} data-target-key={mobile ? undefined : key} data-pan-stop onpointerenter={() => (focusKey = key)} onpointerleave={() => (focusKey = null)} class="min-w-0">
    {#if g}
      <div class="mb-1.5 flex items-center gap-2 px-1">
        {#if mobile}<Boxes class="size-4 text-ink-3" aria-hidden="true" />{:else}
          <span
            class="grid size-7 cursor-grab place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink active:cursor-grabbing"
            title={t("aiAdmin.diagram.dragGroup")}
            aria-hidden="true"
            onpointerdown={e => dnd.press(e, { kind: "group", groupId: g.id, label: g.name, capability: g.capability })}><Boxes class="size-4" /></span
          >{/if}
        <button type="button" class="min-w-0 truncate text-[13.5px] font-semibold hover:underline" title={t("aiAdmin.groups.editNamed", { name: g.name })} onclick={() => onEditGroup?.(g.id)}>{g.name}</button>
        <span class="ml-auto hidden max-w-[55%] truncate text-[11.5px] text-ink-3 {mobile ? '' : 'md:inline'}">{roles.map(roleName).join(i18n.locale === "en" ? ", " : "、")}</span>
      </div>
      <GroupStack group={g} dnd={mobile ? undefined : dnd} {actions} live />
    {:else if m}
      <div
        role="group"
        aria-label={m.model_id}
        data-leaf-provider={m.provider_id}
        data-leaf-model={m.id}
        use:pulseOnChange={`${statFor(adminStore.stats?.models, m)?.calls ?? 0}|${modelHealth(m, adminStore.providers, adminStore.bindings)}`}
        onpointerdown={mobile ? undefined : e => dnd.press(e, { kind: "model", modelId: m.id, label: m.model_id, capability: m.fields.capability })}
        class="rounded-[12px] {mobile ? '' : 'cursor-grab active:cursor-grabbing'}"
      >
        <BrickFace tone={providerTone(m.provider_id)} vendor={{ kind: m.provider_kind }} title={m.model_id} subtitle={live(m)} health={modelHealth(m, adminStore.providers, adminStore.bindings)} lifted={dnd.item?.kind === "model" && dnd.item.modelId === m.id}>
          {#snippet badges()}<ProfileBadges model={m} />{/snippet}
          {#snippet trailing()}{@render modelMenu(m, roles.length === 1 ? roles[0] : undefined)}{/snippet}
        </BrickFace>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet providerBlock(p: Provider, mobile: boolean)}
  {@const h = providerHealth(p)}
  {@const used = usedProviders.includes(p.id)}
  <div data-provider-id={mobile ? undefined : p.id} data-pan-stop class="flex min-h-[52px] items-center gap-2.5 rounded-[14px] border border-l-[3px] border-line bg-surface px-3 py-2 shadow-card {used ? '' : 'opacity-55'}" style="border-left-color: var(--pill-{providerTone(p.id)}-ink)">
    <ProviderIcon kind={p.kind} label={L(p.label)} size="sm" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-[13px] font-semibold">{p.name}</p>
      <p class="truncate text-[11.5px] text-ink-3">{p.last_probe ? `${ms(p.last_probe.latencyMs)} · ` : ""}{L(p.label) || p.kind}</p>
    </div>
    <StateDot state={dot(h)} />
    <span class="sr-only">{t(`aiAdmin.health.${h}`)}</span>
  </div>
{/snippet}

<section class="flex flex-col gap-4">
  <div class="flex flex-wrap items-start gap-x-5 gap-y-3">
    <p class="mr-auto max-w-[60ch] text-[13.5px] text-ink-3">{t("aiAdmin.diagram.intro")}</p>
    <div class="flex flex-wrap items-center gap-2">
      <div class="inline-flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-3 shadow-card" title={t(LIVE_TITLE[liveState])}>
        <span class="relative flex size-2.5" aria-hidden="true">
          {#if liveState === "live"}<span class="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:hidden"></span>{/if}
          <span class="relative size-2.5 rounded-full {liveState === 'failed' ? 'bg-danger' : liveState === 'live' ? 'bg-success' : 'bg-ink-3/45'}"></span>
        </span>
        <span class="text-[12.5px] font-semibold text-ink">{t("aiAdmin.live.label")}</span>
        <span class="text-[12px] text-ink-3 tabular-nums" data-live-updated>
          {#if liveState === "failed"}{t("aiAdmin.live.failed")}{:else if syncedLabel}{t("aiAdmin.live.updated", { time: syncedLabel })}{:else}{t("aiAdmin.live.connecting")}{/if}
        </span>
        <span class="sr-only">{t(LIVE_TITLE[liveState])}</span>
        <Button size="icon-sm" variant="ghost" aria-label={t("aiAdmin.live.refresh")} title={t("aiAdmin.live.refresh")} disabled={adminStore.syncing} onclick={() => adminStore.refresh()}>
          <RefreshCw class={adminStore.syncing ? "animate-spin motion-reduce:animate-none" : ""} />
        </Button>
      </div>
      <div class="hidden items-center gap-1 rounded-full border border-line bg-surface p-1 shadow-card md:flex">
        <Button size="icon-sm" variant="ghost" aria-label={t("aiAdmin.diagram.zoomOut")} onclick={() => zoom(-0.1)}><ZoomOut /></Button>
        <span class="w-11 text-center text-[12px] text-ink-2 tabular-nums">{Math.round(scale * 100)}%</span>
        <Button size="icon-sm" variant="ghost" aria-label={t("aiAdmin.diagram.zoomIn")} onclick={() => zoom(0.1)}><ZoomIn /></Button>
        <Button size="icon-sm" variant="ghost" aria-label={t("aiAdmin.diagram.fit")} onclick={fit}><Maximize /></Button>
      </div>
    </div>
  </div>
  <div class="-mt-1 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-ink-2">
    <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full bg-success"></span>{t("aiAdmin.health.up")}</span>
    <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full bg-[var(--pill-butter-ink)]"></span>{t("aiStatus.state.degraded")}</span>
    <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full bg-danger"></span>{t("aiAdmin.health.down")}</span>
    <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full bg-ink-3/45"></span>{t("aiAdmin.health.unknown")}</span>
  </div>
  <p class="sr-only" aria-live="polite">{announce}</p>

  {#if !adminStore.bindings || !adminStore.groups || !adminStore.models}
    <Skeleton class="h-[420px]" />
  {:else}
    <!-- Desktop / tablet: zoomable canvas -->
    <div class="relative hidden md:block">

      <!-- The canvas itself is the keyboard target for zoom/pan (+ − 0, arrows). -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        bind:this={viewport}
        tabindex="0"
        role="application"
        aria-label={t("aiAdmin.diagram.canvas")}
        aria-describedby="diagram-keys"
        data-pan
        class="canvas relative overflow-hidden rounded-[var(--radius-card)] border border-line/70 {busy ? 'cursor-progress' : panning ? 'cursor-grabbing' : 'cursor-grab'}"
        style="height: {viewportH}px"
        onpointerdown={onViewportDown}
        onpointermove={onViewportMove}
        onpointerup={() => (panning = null)}
        onkeydown={onViewportKey}
      >
        <div bind:this={content} data-pan class="absolute top-0 left-0 w-max origin-top-left p-6" style="transform: translate({panX}px, {panY}px) scale({scale})">
          <svg class="pointer-events-none absolute top-0 left-0 overflow-visible" width={size.w} height={size.h} aria-hidden="true">
            {#each lines as l, i (i)}
              {@const flow = flowing(l)}
              <path d={l.d} fill="none" stroke={l.color} stroke-width={l.kind === "role" ? 2.25 : 1.75} stroke-linecap="round" stroke-dasharray={l.kind === "provider" ? "1 5" : undefined} class="wire {l.kind} {flow ? 'flow' : ''}" data-flow={flow ? "" : undefined} style="opacity: {dimmed(l) ? 0.14 : flow ? 1 : l.kind === 'role' ? 0.9 : 0.75}" />
            {/each}
          </svg>
          <div data-pan class="relative grid grid-cols-[250px_minmax(340px,430px)_250px] gap-x-[96px]">
            <div data-pan class="flex flex-col gap-2.5">
              <h3 class="col-head">{t("aiAdmin.diagram.col.roles")}</h3>
              {#each roleOrder as role, i (role)}
                {#if i > 0 && rowFor(role) !== rowFor(roleOrder[i - 1]!)}<div class="h-3" data-pan></div>{/if}
                {@render roleBlock(role, false)}
              {/each}
            </div>
            <div data-pan class="flex flex-col gap-5">
              <h3 class="col-head">{t("aiAdmin.diagram.col.targets")}</h3>
              {#each layout.rows as row (row.key)}
                {@render targetBlock(row.key, row.roles, false)}
              {:else}
                <p class="rounded-2xl border border-dashed border-line-2 px-4 py-10 text-center text-[13px] text-ink-3">{t("aiAdmin.diagram.noBindings")}</p>
              {/each}
            </div>
            <div data-pan class="flex flex-col gap-2.5">
              <h3 class="col-head">{t("aiAdmin.diagram.col.providers")}</h3>
              {#each providerList as p (p.id)}{@render providerBlock(p, false)}{/each}
            </div>
          </div>
        </div>
      </div>
      <p id="diagram-keys" class="mt-2 text-[12px] text-ink-3">{t("aiAdmin.diagram.keys")}</p>
    </div>

    <!-- Desktop palette: drag a model onto a function or into a group -->
    <div class="hidden rounded-[var(--radius-card)] border border-line/70 bg-surface p-4 shadow-card md:block">
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <h3 class="text-[14.5px] font-semibold">{t("aiAdmin.diagram.palette")}</h3>
        <p class="text-[12.5px] text-ink-3">{t("aiAdmin.diagram.paletteHint")}</p>
        {#if paletteSectionsData.length > 1}
          <Button size="sm" variant="ghost" class="ml-auto" onclick={() => paletteSections?.setAll(!paletteAllOpen)}>{#if paletteAllOpen}<ChevronsDownUp />{t("aiAdmin.picker.collapseAll")}{:else}<ChevronsUpDown />{t("aiAdmin.picker.expandAll")}{/if}</Button>
        {/if}
        <label class="{paletteSectionsData.length > 1 ? '' : 'ml-auto'} flex h-9 w-60 items-center gap-2 rounded-xl border border-line-2 px-2.5 focus-within:border-ink">
          <Search class="size-4 text-ink-3" aria-hidden="true" />
          <input bind:value={paletteQuery} class="min-w-0 flex-1 bg-transparent text-[13px] outline-none" placeholder={t("aiAdmin.picker.search")} aria-label={t("aiAdmin.diagram.paletteSearch")} />
        </label>
      </div>
      <ProviderSections bind:this={paletteSections} bind:allOpen={paletteAllOpen} sections={paletteSectionsData} storageKey="palette" query={paletteQuery} layout="grid">
        {#snippet item(m: ModelProfile)}
          <li onpointerdown={e => dnd.press(e, { kind: "model", modelId: m.id, label: m.model_id, capability: m.fields.capability })} class="cursor-grab active:cursor-grabbing">
            <BrickFace tone={providerTone(m.provider_id)} title={m.model_id} subtitle={t(`aiAdmin.cap.${m.fields.capability}`)} compact health={modelHealth(m, adminStore.providers, adminStore.bindings)}>
              {#snippet trailing()}{@render modelMenu(m)}{/snippet}
            </BrickFace>
          </li>
        {/snippet}
      </ProviderSections>
      {#if !paletteSectionsData.length}<p class="py-6 text-center text-[13px] text-ink-3">{t("aiAdmin.sheet.noMatch")}</p>{/if}
    </div>

    <!-- Phones: one vertical stack per target -->
    <div class="flex flex-col gap-4 md:hidden">
      {#each layout.rows as row (row.key)}
        <div class="rounded-[var(--radius-card)] border border-line/70 bg-surface p-3 shadow-card">
          <div class="flex flex-col gap-2">{#each row.roles as role (role)}{@render roleBlock(role, true)}{/each}</div>
          <div class="flex justify-center py-1.5 text-ink-3" aria-hidden="true"><ArrowDown class="size-4" /></div>
          {@render targetBlock(row.key, row.roles, true)}
          <div class="flex justify-center py-1.5 text-ink-3" aria-hidden="true"><ArrowDown class="size-4" /></div>
          <div class="flex flex-col gap-2">
            {#each providersOf(row.key, adminStore.groups, adminStore.models) as pid (pid)}
              {@const p = adminStore.provider(pid)}
              {#if p}{@render providerBlock(p, true)}{/if}
            {/each}
          </div>
        </div>
      {/each}
      {#if layout.unbound.length}
        <div class="rounded-[var(--radius-card)] border border-dashed border-line-2 p-3">
          <p class="mb-2 px-1 text-[12.5px] font-medium text-ink-3">{t("aiAdmin.diagram.unbound")}</p>
          <div class="flex flex-col gap-2">{#each layout.unbound as role (role)}{@render roleBlock(role, true)}{/each}</div>
        </div>
      {/if}
    </div>
  {/if}
</section>

{#if dnd.item}
  <div class="pointer-events-none fixed z-[60] -translate-x-1/2 -translate-y-1/2" style="left: {dnd.x}px; top: {dnd.y}px">
    <div class="flex items-center gap-2 rounded-[12px] border px-3 py-2 text-[12.5px] font-semibold shadow-pop {dnd.valid ? 'border-ink bg-surface' : 'border-line bg-surface/90'}">
      {#if dnd.item.kind === "group"}<Boxes class="size-4" />{/if}
      <span class="max-w-60 truncate {dnd.item.kind === 'group' ? '' : 'font-mono'}">{dnd.item.label}</span>
      {#if dnd.over && !dnd.valid}<span class="font-normal text-danger">{t("aiAdmin.diagram.cannotDrop")}</span>{/if}
    </div>
  </div>
{/if}

<TargetPicker
  bind:open={pickerOpen}
  capability={pickerRole ? ROLE_CAP[pickerRole] : null}
  title={pickerRole ? t("aiAdmin.bindings.pickOne", { role: roleName(pickerRole) }) : ""}
  current={pickerRole ? keyOfRole(pickerRole) : null}
  onPick={(target, label) => pickerRole && bindRole(pickerRole, target, label)}
/>

<style>
  .canvas {
    background-color: var(--canvas-2);
    background-image: radial-gradient(circle at 12px 12px, color-mix(in oklab, var(--ink-3) 22%, transparent) 1.4px, transparent 1.8px);
    background-size: 24px 24px;
    touch-action: none;
  }
  .col-head {
    padding: 0 4px 2px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-3);
  }
  .wire {
    transition: opacity 160ms;
  }
  /* Routes used in the last minute: dashes flow from function to account. */
  .wire.role.flow {
    stroke-dasharray: 8 6;
    animation: flow-role 0.9s linear infinite;
  }
  .wire.provider.flow {
    animation: flow-provider 0.7s linear infinite;
  }
  @keyframes flow-role {
    to {
      stroke-dashoffset: -14;
    }
  }
  @keyframes flow-provider {
    to {
      stroke-dashoffset: -6;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .wire {
      transition: none;
    }
    .wire.flow {
      animation: none;
    }
  }
</style>
