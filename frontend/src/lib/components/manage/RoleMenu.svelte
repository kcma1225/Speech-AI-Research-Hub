<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Check, ChevronDown } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import type { Role } from "#lib/types.ts";
  import { grantableRoles, roleLabel, roleTone, type GrantableRole } from "./manage.ts";

  /** Role pill that opens a menu of grantable roles. */
  let { role, label, busy = false, disabled = false, onChange }: { role: Role; label: string; busy?: boolean; disabled?: boolean; onChange: (role: GrantableRole) => void } = $props();
  const tone = $derived(roleTone[role]);
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    aria-label={label}
    aria-busy={busy || undefined}
    {disabled}
    class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full pr-2 pl-2.5 text-xs font-medium transition-[filter] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 data-[state=open]:ring-2 data-[state=open]:ring-line-2 dark:hover:brightness-125"
    style="background: var(--pill-{tone}); color: var(--pill-{tone}-ink)"
  >
    {t(roleLabel(role))}
    {#if busy}<Spinner class="size-3" />{:else}<ChevronDown class="size-3.5 opacity-70" />{/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content align="start" sideOffset={6} class="{menuContent} w-64">
      <DropdownMenu.RadioGroup value={role} onValueChange={v => v !== role && onChange(v as GrantableRole)}>
        {#each grantableRoles as option (option)}
          <DropdownMenu.RadioItem value={option} class="{menuItem} h-auto py-2">
            {#snippet children({ checked })}
              <span class="size-2 shrink-0 rounded-full" style="background: var(--pill-{roleTone[option]}-ink)"></span>
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="font-medium">{t(roleLabel(option))}</span>
                <span class="text-[12px] text-ink-3">{t(`manage.role.hint.${option}`)}</span>
              </span>
              {#if checked}<Check class="!text-ink" />{/if}
            {/snippet}
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
