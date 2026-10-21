<script lang="ts">
  import { accountLabel } from "#lib/roles.ts";
  import { DropdownMenu } from "bits-ui";
  import { goto } from "$app/navigation";
  import { Check, LogOut, Monitor, Moon, Settings, Sun } from "@lucide/svelte";
  import { session } from "#lib/stores/session.svelte.ts";
  import { theme } from "#lib/theme.svelte.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { menuContent, menuItem, menuLabel, menuSeparator } from "#lib/components/ui/menu.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import type { ThemePref } from "#lib/types.ts";

  const user = $derived(session.user!);
  const themes: { value: ThemePref; icon: typeof Sun }[] = [
    { value: "system", icon: Monitor },
    { value: "light", icon: Sun },
    { value: "dark", icon: Moon },
  ];
  async function logout() {
    await session.logout();
    // Overrides the (app) layout's /login?next=… redirect: the next account starts on the overview.
    await goto("/login", { replace: true });
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    aria-label={t("user.menu")}
    class="flex items-center gap-2.5 rounded-full border border-line bg-surface py-1 pr-1 pl-1 transition-colors hover:border-line-2 data-[state=open]:border-ink-3 lg:pr-4"
  >
    <Avatar name={user.name} size={32} class="ring-0" />
    <span class="hidden text-left leading-tight lg:block">
      <span class="block max-w-32 truncate text-[13px] font-semibold text-ink">{user.name}</span>
      <span class="block text-[11.5px] text-ink-3">{accountLabel(user)}</span>
    </span>
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content align="end" sideOffset={10} class="{menuContent} w-60">
      <div class="flex items-center gap-3 px-2.5 py-2">
        <Avatar name={user.name} size={36} class="ring-0" />
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold">{user.name}</p>
          <p class="text-xs text-ink-3">{accountLabel(user)}</p>
        </div>
      </div>
      <DropdownMenu.Separator class={menuSeparator} />
      <DropdownMenu.Group>
        <DropdownMenu.GroupHeading class={menuLabel}>{t("user.theme")}</DropdownMenu.GroupHeading>
        <DropdownMenu.RadioGroup value={theme.pref} onValueChange={v => session.update({ theme: v as ThemePref })}>
          {#each themes as option (option.value)}
            <DropdownMenu.RadioItem value={option.value} class={menuItem} closeOnSelect={false}>
              {#snippet children({ checked })}
                <option.icon />
                <span class="flex-1">{t(`theme.${option.value}`)}</span>
                {#if checked}<Check class="!text-ink" />{/if}
              {/snippet}
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Group>
      <DropdownMenu.Separator class={menuSeparator} />
      <DropdownMenu.Item class={menuItem} onSelect={() => goto("/settings")}><Settings />{t("user.settings")}</DropdownMenu.Item>
      <DropdownMenu.Item class={menuItem} onSelect={logout}><LogOut />{t("user.logout")}</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
