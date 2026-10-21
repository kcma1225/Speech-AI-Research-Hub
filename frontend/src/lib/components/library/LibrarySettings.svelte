<script lang="ts">
  import { BookOpen } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { LibrarySettingsView } from "#lib/library/types.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  /** Admin section 「文獻服務」 (GET/PUT /api/library/settings). Mounted on /admin/system. */
  let view = $state<LibrarySettingsView | null>(null);
  let error = $state<string | null>(null);
  let contact = $state("");
  let unpaywall = $state("");
  let grobid = $state("");
  let zType = $state<"group" | "user">("group");
  let zId = $state("");
  type KeyName = "openalex_api_key" | "s2_api_key" | "zotero_api_key";
  let keys = $state<Record<KeyName, string>>({ openalex_api_key: "", s2_api_key: "", zotero_api_key: "" });
  let editing = $state<Record<KeyName, boolean>>({ openalex_api_key: false, s2_api_key: false, zotero_api_key: false });
  let clear = $state<Record<KeyName, boolean>>({ openalex_api_key: false, s2_api_key: false, zotero_api_key: false });
  let errors = $state<{ contact?: string; unpaywall?: string }>({});
  let busy = $state(false);

  function adopt(v: LibrarySettingsView) {
    view = v;
    contact = v.contact_email ?? "";
    unpaywall = v.unpaywall_email ?? "";
    grobid = v.grobid_url ?? "";
    zType = v.zotero_library?.type ?? "group";
    zId = v.zotero_library?.id ?? "";
    keys = { openalex_api_key: "", s2_api_key: "", zotero_api_key: "" };
    editing = { openalex_api_key: false, s2_api_key: false, zotero_api_key: false };
    clear = { openalex_api_key: false, s2_api_key: false, zotero_api_key: false };
  }
  $effect(() => {
    api.get<{ settings: LibrarySettingsView }>("/library/settings").then(r => adopt(r.settings), e => (error = (e as Error).message));
  });

  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  async function save() {
    errors = {};
    if (contact.trim() && !email.test(contact.trim())) errors.contact = t("library.settings.emailInvalid");
    if (unpaywall.trim() && !email.test(unpaywall.trim())) errors.unpaywall = t("library.settings.emailInvalid");
    if (errors.contact || errors.unpaywall) return;
    const body: Record<string, unknown> = {
      contact_email: contact.trim() || null,
      unpaywall_email: unpaywall.trim() || null,
      grobid_url: grobid.trim() || null,
      zotero_library: zId.trim() ? { type: zType, id: zId.trim() } : null,
    };
    for (const k of ["openalex_api_key", "s2_api_key", "zotero_api_key"] as const) {
      if (clear[k]) body[k] = null;
      else if (keys[k].trim()) body[k] = keys[k].trim();
    }
    busy = true;
    try {
      adopt((await api.put<{ settings: LibrarySettingsView }>("/library/settings", body)).settings);
      toasts.show(t("library.settings.saved"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }
</script>

{#snippet keyField(name: KeyName, label: string, hint: string)}
  {@const state = view?.[name]}
  <div class="flex flex-col gap-1.5">
    <span class="text-[13px] font-medium text-ink-2">{label}</span>
    {#if state?.set && !editing[name]}
      <div class="flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-line-2 bg-surface-2/60 px-3.5 py-1.5">
        <span class="mr-auto font-mono text-[13px] {clear[name] ? 'text-ink-3 line-through' : 'text-ink'}">{t("library.settings.keySet", { last4: state.last4 ?? "" })}</span>
        <Button size="sm" variant="ghost" onclick={() => (editing[name] = true)}>{t("library.settings.replace")}</Button>
        <Button size="sm" variant="ghost" onclick={() => (clear[name] = !clear[name])}>{clear[name] ? t("action.cancel") : t("library.settings.clear")}</Button>
      </div>
      <p class="text-[12.5px] text-ink-3">{hint}</p>
    {:else}
      <TextField bind:value={keys[name]} type="password" autocomplete="off" placeholder={state?.set ? t("library.settings.keyPlaceholder") : t("library.settings.keyNotSet")} hint={hint} aria-label={label} />
    {/if}
  </div>
{/snippet}

<Card>
  <CardHeader title={t("library.settings.title")} subtitle={t("library.settings.subtitle")}>
    {#snippet actions()}<span class="grid size-9 place-items-center rounded-xl bg-surface-2 text-ink-3"><BookOpen class="size-4" /></span>{/snippet}
  </CardHeader>
  {#if error}
    <p class="text-[13px] text-danger">{error}</p>
  {:else if !view}
    <div class="flex flex-col gap-3"><Skeleton class="h-11" /><Skeleton class="h-11" /><Skeleton class="h-11" /></div>
  {:else}
    <form
      class="flex flex-col gap-4"
      onsubmit={e => {
        e.preventDefault();
        void save();
      }}
    >
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField bind:value={contact} type="email" label={t("library.settings.contact")} hint={t("library.settings.contactHint")} error={errors.contact} placeholder="lab@example.org" />
        <TextField bind:value={unpaywall} type="email" label={t("library.settings.unpaywall")} hint={t("library.settings.unpaywallHint")} error={errors.unpaywall} />
        {@render keyField("openalex_api_key", t("library.settings.openalex"), t("library.settings.openalexHint"))}
        {@render keyField("s2_api_key", t("library.settings.s2"), t("library.settings.s2Hint"))}
        <TextField bind:value={grobid} type="url" label={t("library.settings.grobid")} hint={t("library.settings.grobidHint")} placeholder="http://grobid:8070" />
      </div>
      <div class="flex flex-col gap-3 rounded-2xl bg-surface-2/60 p-4">
        <p class="text-[13.5px] font-semibold text-ink">{t("library.settings.zotero")}</p>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          {@render keyField("zotero_api_key", t("library.settings.zoteroKey"), t("library.import.zotero.keyHint"))}
          <div class="flex flex-col gap-1.5">
            <span class="text-[13px] font-medium text-ink-2">{t("library.settings.zoteroType")}</span>
            <Segmented bind:value={zType} label={t("library.settings.zoteroType")} options={[{ value: "group", label: t("library.settings.zoteroGroup") }, { value: "user", label: t("library.settings.zoteroUser") }]} class="self-start" />
            <TextField bind:value={zId} label={t("library.settings.zoteroId")} hint={t("library.settings.zoteroIdHint")} inputmode="numeric" class="mt-2" />
          </div>
        </div>
      </div>
      <div class="flex justify-end"><Button type="submit" variant="primary" loading={busy}>{t("library.settings.save")}</Button></div>
    </form>
  {/if}
</Card>
