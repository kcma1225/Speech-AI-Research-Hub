<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import {
    collapse,
    composeZhName,
    formatPersonName,
    initialsOf,
    nameFormPerson,
    TITLES,
    validEnFamily,
    validEnGiven,
    validZhPart,
    type NameForm,
    type Title,
  } from "#lib/people.ts";

  /**
   * Structured name fields (中文姓 + 中文名, English family + optional given name, optional title) with a live preview
   * of how the name appears in the Chinese and English UI. `showErrors` forces every error (e.g. after a submit).
   */
  let { value = $bindable(), showErrors = false, idPrefix = "names" }: { value: NameForm; showErrors?: boolean; idPrefix?: string } = $props();

  let touched = $state({ zhFamily: false, zhGiven: false, enFamily: false, enGiven: false });
  // An error shows once the field was left, has text, or the form was submitted.
  const err = (k: keyof typeof touched, ok: boolean, key: Parameters<typeof t>[0]) => ((showErrors || touched[k] || !!value[k].trim()) && !ok ? t(key) : null);
  const zhFamilyError = $derived(err("zhFamily", validZhPart(value.zhFamily), "people.zhInvalid"));
  const zhGivenError = $derived(err("zhGiven", validZhPart(value.zhGiven), "people.zhInvalid"));
  const enFamilyError = $derived(err("enFamily", validEnFamily(value.enFamily), "people.enFamilyInvalid"));
  const enGivenError = $derived(!validEnGiven(value.enGiven) ? t("people.enGivenInvalid") : null);

  const titleOptions = $derived<{ value: Title | ""; label: string }[]>([
    { value: "", label: t("people.title.none") },
    ...TITLES.map(code => ({ value: code, label: t(`people.title.${code}`) })),
  ]);

  const person = $derived(nameFormPerson(value));
  const zhPreview = $derived(validZhPart(value.zhFamily) && validZhPart(value.zhGiven) ? composeZhName(collapse(value.zhFamily), collapse(value.zhGiven)) : "");
  const enPreview = $derived(validEnFamily(value.enFamily) && validEnGiven(value.enGiven) ? formatPersonName({ person }, "en") : "");
  const enFormal = $derived(enPreview ? formatPersonName({ person }, "en", "formal") : "");
</script>

<div class="flex flex-col gap-5">
  <fieldset class="flex min-w-0 flex-col gap-2">
    <legend class="mb-2 text-[13.5px] font-semibold text-ink">{t("people.section.zh")}</legend>
    <div class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
      <TextField
        id="{idPrefix}-zh-family"
        label={t("people.zhFamily")}
        bind:value={value.zhFamily}
        placeholder={t("people.zhFamily.placeholder")}
        autocomplete="family-name"
        maxlength={20}
        required
        error={zhFamilyError}
        onblur={() => (touched.zhFamily = true)}
      />
      <TextField
        id="{idPrefix}-zh-given"
        label={t("people.zhGiven")}
        bind:value={value.zhGiven}
        placeholder={t("people.zhGiven.placeholder")}
        autocomplete="given-name"
        maxlength={20}
        required
        error={zhGivenError}
        onblur={() => (touched.zhGiven = true)}
      />
    </div>
    {#if !zhFamilyError && !zhGivenError}<p class="text-[12.5px] text-ink-3">{t("people.zhHint")}</p>{/if}
  </fieldset>

  <fieldset class="flex min-w-0 flex-col gap-2">
    <legend class="mb-2 text-[13.5px] font-semibold text-ink">{t("people.section.en")}</legend>
    <div class="grid gap-3 sm:grid-cols-2">
      <TextField
        id="{idPrefix}-en-family"
        label={t("people.enFamily")}
        bind:value={value.enFamily}
        placeholder={t("people.enFamily.placeholder")}
        autocomplete="off"
        autocapitalize="words"
        spellcheck={false}
        lang="en"
        maxlength={40}
        required
        error={enFamilyError}
        onblur={() => (touched.enFamily = true)}
      />
      <TextField
        id="{idPrefix}-en-given"
        label={t("people.enGiven")}
        bind:value={value.enGiven}
        placeholder={t("people.enGiven.placeholder")}
        autocomplete="off"
        autocapitalize="words"
        spellcheck={false}
        lang="en"
        maxlength={40}
        error={enGivenError}
        onblur={() => (touched.enGiven = true)}
      />
    </div>
    {#if !enFamilyError && !enGivenError}<p class="text-[12.5px] text-ink-3">{t("people.enHint")}</p>{/if}
    <div class="mt-2 flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("people.title")}</span>
      <Select bind:value={value.title} label={t("people.title")} options={titleOptions} class="w-full sm:w-64" />
      <p class="text-[12.5px] text-ink-3">{t("people.title.hint")}</p>
    </div>
  </fieldset>

  <section class="rounded-2xl bg-surface-2 p-4" aria-live="polite" aria-label={t("people.preview")}>
    <p class="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{t("people.preview")}</p>
    {#if zhPreview || enPreview}
      <dl class="mt-3 grid gap-3 sm:grid-cols-2">
        <div class="flex min-w-0 items-center gap-3">
          <span class="inline-grid size-9 shrink-0 place-items-center"><Avatar name={zhPreview || "?"} size={36} class="ring-0" /></span>
          <div class="min-w-0">
            <dt class="text-[12px] text-ink-3">{t("people.preview.zh")}</dt>
            <dd class="truncate text-[15px] font-semibold text-ink" lang="zh-Hant">{zhPreview || "—"}</dd>
          </div>
        </div>
        <div class="flex min-w-0 items-center gap-3">
          <span
            class="inline-grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-[13px] font-semibold text-ink-2"
            aria-hidden="true">{enPreview ? initialsOf(enPreview) : "?"}</span
          >
          <div class="min-w-0">
            <dt class="text-[12px] text-ink-3">{t("people.preview.en")}</dt>
            <dd class="truncate text-[15px] font-semibold text-ink" lang="en">{enPreview || "—"}</dd>
            {#if enFormal && enFormal !== enPreview}
              <dd class="truncate text-[12.5px] text-ink-3" lang="en">{t("people.preview.formal")}: {enFormal}</dd>
            {/if}
          </div>
        </div>
      </dl>
    {:else}
      <p class="mt-2 text-[13px] text-ink-3">{t("people.preview.empty")}</p>
    {/if}
  </section>
</div>
