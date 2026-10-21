<script lang="ts" module>
  import type { AiRole } from "#lib/ai/status.svelte.ts";
  /** Menu/keyboard equivalents of every drag action (the diagram implements them). */
  export type StackActions = {
    move: (groupId: string, from: number, to: number) => void;
    moveTo: (groupId: string, index: number, toGroupId: string) => void;
    remove: (groupId: string, index: number) => void;
    bind: (groupId: string, index: number, role: AiRole) => void;
    edit: (groupId: string) => void;
  };
</script>

<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { ArrowDown, ArrowUp, Boxes, Ellipsis, FolderInput, Link2, Pencil, Repeat, Scale, Trash2, Waypoints } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { ROLE_KEYS, type Group } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { descendants, modelHealth, ms, pct, providerTone, ROLE_CAP, ROLE_ORDER, shares, statFor } from "#lib/ai/routing.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { menuContent, menuItem, menuLabel, menuSeparator } from "#lib/components/ui/menu.ts";
  import BrickFace from "./BrickFace.svelte";
  import ProfileBadges from "../ProfileBadges.svelte";
  import GroupStack from "./GroupStack.svelte";
  import type { DragController } from "./dnd.svelte.ts";

  /** A group as a baseplate of stacked bricks (models and nested groups); interactive when `dnd`/`actions` are given. */
  let { group, dnd, actions, depth = 0, seen = [], live = false }: { group: Group; dnd?: DragController; actions?: StackActions; depth?: number; seen?: string[]; live?: boolean } = $props();

  const pcts = $derived(shares(group.members));
  const enabledIdx = $derived(group.members.map((m, i) => (m.enabled ? i : -1)).filter(i => i >= 0));
  const seqOf = (i: number) => {
    const m = group.members[i]!;
    if (!m.enabled) return "–";
    if (group.strategy === "fallback") return String(enabledIdx.indexOf(i) + 1);
    if (group.strategy === "load_balance") return `${pcts[i]}%`;
    return "↻";
  };
  const seqTitle = (i: number) =>
    !group.members[i]!.enabled
      ? t("aiAdmin.groups.disabledBrick")
      : group.strategy === "fallback"
        ? enabledIdx.indexOf(i) === 0
          ? t("aiAdmin.groups.first")
          : t("aiAdmin.groups.fallbackN", { n: enabledIdx.indexOf(i) })
        : group.strategy === "load_balance"
          ? t("aiAdmin.groups.share", { p: pcts[i] ?? 0 })
          : t("aiAdmin.groups.rotates");
  const sKey = $derived(`aiAdmin.strategy.${group.strategy}` as MessageKey);
  const roles = $derived(ROLE_ORDER.filter(r => ROLE_CAP[r] === group.capability));
  const moveTargets = (childId: string | null) => {
    const banned = childId ? descendants(adminStore.groups, childId) : new Set<string>();
    return (adminStore.groups ?? []).filter(g => g.id !== group.id && g.capability === group.capability && !banned.has(g.id));
  };
  const over = $derived(dnd?.item && dnd.over?.kind === "group" && dnd.over.groupId === group.id ? dnd.over : null);
  const dropValid = $derived(Boolean(over && dnd?.valid));

  function onKey(e: KeyboardEvent, i: number) {
    if (!actions || !e.altKey) return;
    if (e.key === "ArrowUp" && i > 0) (e.preventDefault(), actions.move(group.id, i, i - 1));
    if (e.key === "ArrowDown" && i < group.members.length - 1) (e.preventDefault(), actions.move(group.id, i, i + 1));
  }
</script>

<div
  class="plate rounded-[16px] p-2 {depth ? 'nested' : ''} {dropValid ? 'drop-ok' : over ? 'drop-bad' : ''}"
  data-group-node={group.id}
>
  <div class="mb-1 flex min-w-0 items-center gap-2 px-1 pt-0.5 text-[12px]">
    {#if group.strategy === "fallback"}<Waypoints class="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />{:else if group.strategy === "load_balance"}<Scale class="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />{:else}<Repeat class="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />{/if}
    {#if depth}<span class="min-w-0 truncate font-semibold text-ink-2">{group.name}</span>{/if}
    <span class="shrink-0 text-ink-3">{t(sKey)}</span>
    {#if actions && depth}
      <button type="button" class="ml-auto grid size-8 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("aiAdmin.groups.editNamed", { name: group.name })} onclick={() => actions.edit(group.id)}><Pencil class="size-3.5" /></button>
    {/if}
  </div>
  <ol class="flex flex-col gap-1.5" data-drop={dnd ? "group" : undefined} data-group-id={group.id} aria-label={t("aiAdmin.groups.stackLabel", { name: group.name })}>
    {#each group.members as m, i (m.id ?? i)}
      {@const model = adminStore.model(m.model_ref)}
      {@const child = adminStore.group(m.child_group_id)}
      {@const s = live && model ? statFor(adminStore.stats?.models, model) : undefined}
      <li
        data-slot-index={i}
        class="relative {over && over.index === i ? 'insert-before' : ''}"
        onpointerdown={dnd ? e => dnd.press(e, { kind: "member", groupId: group.id, index: i, label: model?.model_id ?? child?.name ?? "?", capability: group.capability, modelRef: m.model_ref, childGroupId: m.child_group_id }) : undefined}
      >
        {#if child && depth < 5 && !seen.includes(child.id)}
          <div class="flex items-start gap-1.5">
            <span class="mt-2 grid h-6 min-w-6 shrink-0 place-items-center rounded-md bg-ink px-1 text-[11px] font-bold text-primary-ink tabular-nums" title={seqTitle(i)}>{seqOf(i)}</span>
            <div class="min-w-0 flex-1 {m.enabled ? '' : 'opacity-55'}"><GroupStack group={child} {dnd} {actions} depth={depth + 1} seen={[...seen, group.id]} {live} /></div>
          </div>
        {:else}
          <!-- Focusable so Alt+↑↓ can reorder; every other action is in the brick's menu button. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div role="group" aria-roledescription={t("aiAdmin.diagram.brick")} tabindex={actions ? 0 : undefined} onkeydown={e => onKey(e, i)} class="rounded-[12px] outline-offset-2" data-leaf-provider={model?.provider_id} aria-label={actions ? t("aiAdmin.diagram.brickLabel", { name: model?.model_id ?? child?.name ?? "?", n: i + 1 }) : undefined}>
            <BrickFace
              tone={child ? "stone" : providerTone(model?.provider_id)}
              vendor={!child && model ? { kind: model.provider_kind } : undefined}
              title={child ? child.name : (model?.model_id ?? m.model_id ?? "?")}
              subtitle={child ? t("aiAdmin.groups.memberCount", { n: child.members.length }) : s ? `${ms(s.p50_ms)} · ${pct(s.success_rate)}` : (model?.provider_name ?? "")}
              mono={!child}
              seq={seqOf(i)}
              seqTitle={seqTitle(i)}
              health={model ? modelHealth(model, adminStore.providers, adminStore.bindings) : undefined}
              dim={!m.enabled}
              compact={depth > 0}
              lifted={dnd?.item?.kind === "member" && dnd.item.groupId === group.id && dnd.item.index === i}
              class={dnd ? "cursor-grab active:cursor-grabbing" : ""}
            >
              {#snippet badges()}
                {#if child}<Boxes class="size-3.5" aria-hidden="true" />{:else if model}<ProfileBadges model={model} limit={depth === 0} />{/if}
              {/snippet}
              {#snippet trailing()}
                {#if actions}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger aria-label={t("aiAdmin.diagram.brickMenu", { name: model?.model_id ?? child?.name ?? "" })} class="-mr-1 grid size-9 shrink-0 place-items-center rounded-full text-[var(--bi)] hover:bg-black/5 data-[state=open]:bg-black/5">
                      <Ellipsis class="size-4" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="end" sideOffset={6} class={menuContent}>
                        <DropdownMenu.Item class={menuItem} disabled={i === 0} onSelect={() => actions.move(group.id, i, i - 1)}><ArrowUp />{t("aiAdmin.groups.up")}</DropdownMenu.Item>
                        <DropdownMenu.Item class={menuItem} disabled={i === group.members.length - 1} onSelect={() => actions.move(group.id, i, i + 1)}><ArrowDown />{t("aiAdmin.groups.down")}</DropdownMenu.Item>
                        {#if moveTargets(m.child_group_id).length}
                          <DropdownMenu.Sub>
                            <DropdownMenu.SubTrigger class={menuItem}><FolderInput />{t("aiAdmin.diagram.moveTo")}</DropdownMenu.SubTrigger>
                            <DropdownMenu.SubContent class={menuContent} sideOffset={4}>
                              {#each moveTargets(m.child_group_id) as g (g.id)}
                                <DropdownMenu.Item class={menuItem} onSelect={() => actions.moveTo(group.id, i, g.id)}><Boxes />{g.name}</DropdownMenu.Item>
                              {/each}
                            </DropdownMenu.SubContent>
                          </DropdownMenu.Sub>
                        {/if}
                        <DropdownMenu.Sub>
                          <DropdownMenu.SubTrigger class={menuItem}><Link2 />{t("aiAdmin.diagram.bindTo")}</DropdownMenu.SubTrigger>
                          <DropdownMenu.SubContent class={menuContent} sideOffset={4}>
                            <div class={menuLabel}>{t("aiAdmin.diagram.bindToHint")}</div>
                            {#each roles as r (r)}
                              <DropdownMenu.Item class={menuItem} onSelect={() => actions.bind(group.id, i, r)}>{t(ROLE_KEYS[r].label)}</DropdownMenu.Item>
                            {/each}
                          </DropdownMenu.SubContent>
                        </DropdownMenu.Sub>
                        <DropdownMenu.Separator class={menuSeparator} />
                        <DropdownMenu.Item class="{menuItem} text-danger [&_svg]:!text-danger" onSelect={() => actions.remove(group.id, i)}><Trash2 />{t("aiAdmin.groups.remove")}</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                {/if}
              {/snippet}
            </BrickFace>
          </div>
        {/if}
      </li>
    {:else}
      <li class="rounded-xl border border-dashed border-line-2 px-3 py-3 text-center text-[12px] text-ink-3">{t("aiAdmin.groups.noBricks")}</li>
    {/each}
    {#if over && over.index >= group.members.length && group.members.length}<li class="insert-end" aria-hidden="true"></li>{/if}
  </ol>
</div>

<style>
  .plate {
    background-color: var(--surface-2);
    background-image: radial-gradient(circle at 8px 8px, color-mix(in oklab, var(--ink-3) 16%, transparent) 2px, transparent 2.4px);
    background-size: 16px 16px;
    border: 1px solid var(--line);
    transition: box-shadow 140ms, border-color 140ms;
  }
  .plate.nested {
    background-color: var(--surface);
  }
  .plate.drop-ok {
    border-color: var(--ink);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--ink) 14%, transparent);
  }
  .plate.drop-bad {
    border-color: var(--danger);
  }
  .insert-before::before,
  .insert-end {
    content: "";
    display: block;
    height: 3px;
    border-radius: 2px;
    background: var(--ink);
  }
  .insert-before::before {
    position: absolute;
    inset: -5px 6px auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .plate {
      transition: none;
    }
  }
</style>
