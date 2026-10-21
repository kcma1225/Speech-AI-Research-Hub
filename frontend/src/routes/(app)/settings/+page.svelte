<script lang="ts">
  import { accountLabel } from "#lib/roles.ts";
  import { untrack } from "svelte";
  import { Tabs } from "bits-ui";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Bell, Laptop, Monitor, Moon, PenLine, Smartphone, Sparkles, Sun, SlidersHorizontal, UserRound } from "@lucide/svelte";
  import MemorySettings from "#lib/components/agent/MemorySettings.svelte";
  import { api } from "#lib/api.ts";
  import { i18n, relativeTime, t } from "#lib/i18n.svelte.ts";
  import { theme } from "#lib/theme.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { deviceSubscribed, disablePush, enablePush, pushSupported } from "#lib/push.ts";
  import type { Locale, Preferences, SessionRow, ThemePref } from "#lib/types.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  const user = $derived(session.user!);
  const tabs = [
    { value: "general", label: "settings.tab.general", icon: SlidersHorizontal },
    { value: "account", label: "settings.tab.account", icon: UserRound },
    { value: "notifications", label: "settings.tab.notifications", icon: Bell },
    { value: "sessions", label: "settings.tab.sessions", icon: Laptop },
    { value: "editor", label: "settings.tab.editor", icon: PenLine },
    { value: "assistant", label: "agent.settings.tab", icon: Sparkles },
  ] as const satisfies readonly { value: string; label: MessageKey; icon: unknown }[];
  type Tab = (typeof tabs)[number]["value"];
  // Admin accounts are system-only: no assistant (memories) or editor preferences.
  const tabsFor = (role: string | undefined) => (role === "admin" ? tabs.filter(x => x.value !== "assistant" && x.value !== "editor") : tabs);
  const shownTabs = $derived(tabsFor(session.user?.role));
  const fromUrl = page.url.searchParams.get("tab");
  let tab = $state<Tab>(tabsFor(session.user?.role).some(x => x.value === fromUrl) ? (fromUrl as Tab) : "general");
  // Mirror the tab into ?tab= (shallow) only when it changes; reading page.url here would loop.
  let syncedTab: string | null = fromUrl;
  $effect(() => {
    const current = tab;
    if (current === syncedTab) return;
    syncedTab = current;
    untrack(() => {
      const url = new URL(page.url.href);
      url.searchParams.set("tab", current);
      void goto(url, { state: page.state, shallow: true, replace: true });
    });
  });

  /** Resolves true when the server accepted the change. */
  async function save(patch: Parameters<typeof session.update>[0], ok = true) {
    try {
      await session.update(patch);
      if (ok) toasts.show(t("settings.saved"), "success");
      return true;
    } catch (e) {
      toasts.show((e as Error).message, "error");
      return false;
    }
  }

  // General (the theme can also change from the user menu, so read it from the store)
  const themeValue = $derived<ThemePref>(theme.pref);
  const localeValue = $derived<Locale>(i18n.locale);

  // Account
  let name = $state(session.user!.name);
  let savingName = $state(false);
  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let savingPassword = $state(false);
  const newPasswordError = $derived(newPassword && newPassword.length < 8 ? t("settings.password.short") : null);
  const confirmError = $derived(confirmPassword && newPassword.length >= 8 && confirmPassword !== newPassword ? t("settings.password.mismatch") : null);
  async function saveName() {
    savingName = true;
    await save({ name: name.trim() });
    savingName = false;
  }
  async function savePassword() {
    savingPassword = true;
    // Keep what was typed when the server refuses it (e.g. a wrong current password).
    if (await save({ currentPassword, newPassword })) currentPassword = newPassword = confirmPassword = "";
    savingPassword = false;
  }

  // Notifications
  let push = $state<{ enabled: boolean; publicKey: string | null; device: boolean } | null>(null);
  let pushBusy = $state(false);
  $effect(() => {
    if (tab !== "notifications" || push) return;
    Promise.all([api.get<{ enabled: boolean; publicKey: string | null }>("/push"), deviceSubscribed()]).then(([p, device]) => (push = { ...p, device }));
  });
  async function togglePush(on: boolean) {
    if (!push?.publicKey) return;
    pushBusy = true;
    try {
      if (on) await enablePush(push.publicKey);
      else await disablePush();
      push = { ...push, device: on };
    } catch (e) {
      toasts.show((e as Error).message === "denied" ? t("settings.push.unsupported") : (e as Error).message, "error");
    }
    pushBusy = false;
  }
  const notifyKeys = ["tasks", "slideRendered", "reviews", "replies", "mediaTranscoded"] as const;
  function setNotify(key: keyof Preferences["notify"], value: boolean) {
    void save({ preferences: { notify: { [key]: value } } }, false);
  }

  // Sessions
  let sessions = $state<SessionRow[] | null>(null);
  $effect(() => {
    if (tab === "sessions" && !sessions) api.get<{ sessions: SessionRow[] }>("/auth/sessions").then(r => (sessions = r.sessions));
  });
  let revoking = $state<string | null>(null);
  async function revoke(id: string) {
    revoking = id;
    try {
      await api.del(`/auth/sessions/${id}`);
      sessions = sessions?.filter(s => s.id !== id) ?? null;
      toasts.show(t("settings.sessions.revoked"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      revoking = null;
    }
  }
  function describe(ua: string | null) {
    if (!ua) return { label: t("settings.sessions.unknown"), mobile: false };
    const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    return { label: os ? `${browser} · ${os}` : browser, mobile: /Mobile|iPhone|Android/.test(ua) };
  }

  // Editor
  let fontSize = $state(String(session.user!.preferences.editor.fontSize));
  let layout = $state(session.user!.preferences.editor.layout);
</script>

<!-- `inline` keeps small controls (switches) beside their label on phones too. -->
{#snippet row(label: string, hint: string | undefined, control: import("svelte").Snippet, inline = false)}
  <div class="flex border-b border-line py-5 first:pt-0 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8 {inline ? 'items-center justify-between gap-4' : 'flex-col gap-3'}">
    <div class="min-w-0">
      <p class="text-[14px] font-medium text-ink">{label}</p>
      {#if hint}<p class="mt-0.5 text-[13px] text-ink-3">{hint}</p>{/if}
    </div>
    <div class="shrink-0">{@render control()}</div>
  </div>
{/snippet}

{#snippet themeControl()}
  <Segmented
    label={t("settings.appearance")}
    value={themeValue}
    onValueChange={v => save({ theme: v }, false)}
    options={[
      { value: "system", label: t("theme.system"), icon: Monitor },
      { value: "light", label: t("theme.light"), icon: Sun },
      { value: "dark", label: t("theme.dark"), icon: Moon },
    ]}
  />
{/snippet}
{#snippet localeControl()}
  <Select
    label={t("settings.language")}
    value={localeValue}
    onValueChange={v => save({ locale: v }, false)}
    options={[
      { value: "zh-TW", label: "繁體中文" },
      { value: "en", label: "English" },
    ]}
  />
{/snippet}
{#snippet sizeControl()}
  <Select
    label={t("settings.editor.fontSize")}
    bind:value={fontSize}
    onValueChange={v => save({ preferences: { editor: { fontSize: Number(v) } } }, false)}
    options={[13, 14, 15, 16, 18, 20].map(n => ({ value: String(n), label: `${n} px` }))}
  />
{/snippet}
{#snippet layoutControl()}
  <Segmented
    label={t("settings.editor.layout")}
    bind:value={layout}
    onValueChange={v => save({ preferences: { editor: { layout: v } } }, false)}
    options={[
      { value: "split", label: t("settings.editor.layout.split") },
      { value: "edit", label: t("settings.editor.layout.edit") },
      { value: "preview", label: t("settings.editor.layout.preview") },
    ]}
  />
{/snippet}

<svelte:head><title>{t("settings.title")} · Speech-AI Hub</title></svelte:head>

<PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />

<Tabs.Root bind:value={tab} orientation="vertical" class="grid gap-5 lg:grid-cols-[220px_1fr] lg:gap-8">
  <Tabs.List class="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
    {#each shownTabs as item (item.value)}
      <Tabs.Trigger
        value={item.value}
        class="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2.5 rounded-full px-4 text-[14px] font-medium whitespace-nowrap text-ink-2 transition-colors hover:text-ink data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-card lg:w-full"
      >
        <item.icon class="size-4" />{t(item.label)}
      </Tabs.Trigger>
    {/each}
  </Tabs.List>

  <div class="min-w-0">
    <Tabs.Content value="general" class="outline-none">
      <Card>
        {@render row(t("settings.appearance"), t("settings.appearance.hint"), themeControl)}
        {@render row(t("settings.language"), t("settings.language.hint"), localeControl)}
      </Card>
      <div class="mt-5 grid grid-cols-3 gap-3 sm:gap-4">
        {#each ["system", "light", "dark"] as const as option (option)}
          <button
            type="button"
            onclick={() => void save({ theme: option }, false)}
            class="group rounded-[20px] border-2 p-2 text-left transition-colors {themeValue === option ? 'border-ink' : 'border-transparent hover:border-line-2'}"
            aria-pressed={themeValue === option}
          >
            <div class="relative aspect-[4/3] overflow-hidden rounded-[14px] ring-1 ring-line">
              {#each option === "system" ? ["light", "dark"] : [option] as mode, i (mode)}
                <div
                  class="absolute inset-0 p-2.5 {option === 'system' && i === 1 ? '[clip-path:polygon(100%_0,100%_100%,0_100%)]' : ''}"
                  style="background:{mode === 'dark' ? '#121211' : '#ecebe7'}"
                >
                  <div class="flex h-full gap-1.5">
                    <div class="flex w-1/4 flex-col gap-1 pt-1">
                      {#each [0, 1, 2] as j (j)}<div class="h-1.5 rounded-full" style="background:{mode === 'dark' ? '#3a3834' : '#d6d3cc'}"></div>{/each}
                    </div>
                    <div class="flex flex-1 flex-col gap-1.5">
                      <div class="h-1/2 rounded-md hero-gradient" data-theme={mode}></div>
                      <div class="flex flex-1 gap-1.5">
                        <div class="flex-1 rounded-md" style="background:{mode === 'dark' ? '#1c1b1a' : '#fff'}"></div>
                        <div class="flex-1 rounded-md" style="background:{mode === 'dark' ? '#1c1b1a' : '#fff'}"></div>
                      </div>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
            <p class="mt-2 px-1 text-[13px] font-medium {themeValue === option ? 'text-ink' : 'text-ink-2'}">{t(`theme.${option}`)}</p>
          </button>
        {/each}
      </div>
    </Tabs.Content>

    <Tabs.Content value="account" class="flex flex-col gap-5 outline-none">
      <Card>
        <div class="mb-6 flex items-center gap-4">
          <Avatar name={name || user.name} size={56} class="ring-0" />
          <div>
            <p class="text-[17px] font-semibold">{user.name}</p>
            <div class="mt-1"><Pill tone="lilac" size="sm">{accountLabel(user)}</Pill></div>
          </div>
        </div>
        <form
          class="flex flex-col gap-4 sm:flex-row sm:items-end"
          onsubmit={e => {
            e.preventDefault();
            void saveName();
          }}
        >
          <TextField class="flex-1" label={t("settings.name")} hint={t("settings.name.hint")} bind:value={name} maxlength={80} autocomplete="username" />
          <Button type="submit" variant="primary" loading={savingName} disabled={!name.trim() || name.trim() === user.name} class="sm:mb-[22px]">{t("action.save")}</Button>
        </form>
      </Card>
      <Card>
        <h2 class="text-[15px] font-semibold">{t("settings.password")}</h2>
        <p class="mt-0.5 mb-5 text-[13px] text-ink-3">{t("settings.password.hint")}</p>
        <form
          class="grid gap-4 sm:max-w-md"
          onsubmit={e => {
            e.preventDefault();
            void savePassword();
          }}
        >
          <input type="text" autocomplete="username" value={user.name} readonly hidden />
          <TextField type="password" label={t("settings.password.current")} bind:value={currentPassword} autocomplete="current-password" />
          <TextField type="password" label={t("settings.password.new")} bind:value={newPassword} autocomplete="new-password" error={newPasswordError} />
          <TextField type="password" label={t("settings.password.confirm")} bind:value={confirmPassword} autocomplete="new-password" error={confirmError} />
          <Button type="submit" variant="primary" class="w-fit" loading={savingPassword} disabled={!currentPassword || !newPassword || newPassword !== confirmPassword || !!newPasswordError}>
            {t("settings.password")}
          </Button>
        </form>
      </Card>
    </Tabs.Content>

    <Tabs.Content value="notifications" class="flex flex-col gap-5 outline-none">
      <Card>
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex gap-3.5">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl" style="background:var(--pill-peach);color:var(--pill-peach-ink)"><Bell class="size-[18px]" /></span>
            <div>
              <p class="text-[14px] font-medium">{t("settings.push")}</p>
              <p class="mt-0.5 max-w-md text-[13px] text-ink-3">{t("settings.push.hint")}</p>
              {#if push}
                <p class="mt-2 text-[12.5px] font-medium {push.device ? 'text-success' : 'text-ink-3'}">
                  {!pushSupported() ? t("settings.push.unsupported") : !push.enabled ? t("settings.push.unavailable") : push.device ? t("settings.push.on") : t("settings.push.off")}
                </p>
              {/if}
            </div>
          </div>
          {#if !push}
            <Skeleton class="h-10 w-40 rounded-full" />
          {:else if push.enabled && pushSupported()}
            <div class="flex gap-2">
              {#if push.device}<Button size="md" variant="ghost" onclick={() => api.post("/push/test").then(() => toasts.show(t("settings.push.testSent"), "success"), e => toasts.show(e.message, "error"))}>{t("settings.push.test")}</Button>{/if}
              <Button size="md" variant={push.device ? "secondary" : "primary"} loading={pushBusy} onclick={() => togglePush(!push!.device)}>
                {push.device ? t("settings.push.disable") : t("settings.push.enable")}
              </Button>
            </div>
          {/if}
        </div>
      </Card>
      <Card>
        <h2 class="text-[15px] font-semibold">{t("settings.notify.events")}</h2>
        <p class="mt-0.5 mb-5 text-[13px] text-ink-3">{t("settings.notify.eventsHint")}</p>
        <div>
          {#each notifyKeys as key (key)}
            {#snippet toggle()}
              <Switch label={t(`settings.notify.${key}`)} checked={user.preferences.notify[key]} onCheckedChange={v => setNotify(key, v)} />
            {/snippet}
            {@render row(t(`settings.notify.${key}`), undefined, toggle, true)}
          {/each}
        </div>
      </Card>
    </Tabs.Content>

    <Tabs.Content value="sessions" class="outline-none">
      <Card>
        <h2 class="text-[15px] font-semibold">{t("settings.sessions")}</h2>
        <p class="mt-0.5 mb-4 text-[13px] text-ink-3">{t("settings.sessions.hint")}</p>
        {#if !sessions}
          <div class="flex flex-col gap-2">{#each [0, 1] as i (i)}<Skeleton class="h-16" />{/each}</div>
        {:else}
          <ul class="flex flex-col">
            {#each sessions as s (s.id)}
              {@const d = describe(s.user_agent)}
              <li class="flex items-center gap-3.5 border-b border-line py-3.5 last:border-0">
                <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2">
                  {#if d.mobile}<Smartphone class="size-[18px]" />{:else}<Laptop class="size-[18px]" />{/if}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="flex items-center gap-2 text-[14px] font-medium">
                    <span class="truncate">{d.label}</span>
                    {#if s.current}<Pill tone="mint" size="sm" dot>{t("settings.sessions.current")}</Pill>{/if}
                  </p>
                  <p class="mt-0.5 truncate text-[12.5px] text-ink-3">{s.ip ?? ""}{s.ip ? " · " : ""}{t("settings.sessions.lastSeen", { when: relativeTime(s.last_seen_at) })}</p>
                </div>
                {#if !s.current}<Button size="sm" variant="secondary" loading={revoking === s.id} onclick={() => revoke(s.id)}>{t("settings.sessions.revoke")}</Button>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    </Tabs.Content>

    <Tabs.Content value="editor" class="flex flex-col gap-5 outline-none">
      <Card>
        <h2 class="mb-5 text-[15px] font-semibold">{t("settings.editor")}</h2>
        <div>
          {@render row(t("settings.editor.fontSize"), undefined, sizeControl)}
          {@render row(t("settings.editor.layout"), undefined, layoutControl)}
        </div>
      </Card>
      <Card>
        <p class="mb-3 text-[12px] font-medium tracking-[0.08em] text-ink-3 uppercase">{t("settings.editor.preview")}</p>
        <div class="grid gap-0 overflow-hidden rounded-2xl border border-line {layout === 'split' ? 'sm:grid-cols-2' : ''}">
          {#if layout !== "preview"}
            <pre class="m-0 bg-surface-2 p-4 font-mono leading-relaxed whitespace-pre-wrap text-ink-2" style="font-size:{fontSize}px">## {t("settings.editor.sample.heading")}
- {t("settings.editor.sample.item1md")}
- {t("settings.editor.sample.item2")}</pre>
          {/if}
          {#if layout !== "edit"}
            <div class="p-4 leading-relaxed" style="font-size:{fontSize}px">
              <p class="mb-2 font-semibold" style="font-size:1.2em">{t("settings.editor.sample.heading")}</p>
              <ul class="list-disc pl-5 text-ink-2">
                <li>{t("settings.editor.sample.item1a")}<strong class="text-ink">Whisper</strong>{t("settings.editor.sample.item1b")}</li>
                <li>{t("settings.editor.sample.item2")}</li>
              </ul>
            </div>
          {/if}
        </div>
      </Card>
    </Tabs.Content>

    <Tabs.Content value="assistant" class="outline-none">{#if tab === "assistant" && session.user?.role !== "admin"}<MemorySettings />{/if}</Tabs.Content>
  </div>
</Tabs.Root>
