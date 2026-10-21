<script lang="ts">
  import { goto } from "$app/navigation";
  import { ArrowLeft, FileInput, Info, Sparkles, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import StudyInterview from "#lib/components/agent/StudyInterview.svelte";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import MarkdownEditor from "#lib/components/markdown/MarkdownEditor.svelte";
  import DocImportSheet from "#lib/components/doc-import/DocImportSheet.svelte";
  import type { ImportedDocument } from "#lib/components/doc-import/api.ts";
  import type { DirectoryUser, StudyDetail } from "#lib/studies/types.ts";
  import { STUDY_SLUG_RE } from "#lib/studies/ui.ts";
  import { MATURITIES } from "#lib/agent/maturity.ts";

  let title = $state("");
  let slug = $state("");
  let summary = $state("");
  let format = $state<"prose" | "bullets">("prose");
  let maturity = $state("");
  // 「從檔案匯入」: prefill the summary (and the title when it is still empty) from a document.
  let importOpen = $state(false);
  function imported(markdown: string, doc: ImportedDocument) {
    summary = summary.trim() ? `${summary.replace(/\s+$/, "")}\n\n${markdown}` : markdown;
    if (!title.trim() && doc.title) title = doc.title.slice(0, 200);
    toasts.show(doc.truncated ? t("docimport.truncated") : t("docimport.done", { name: doc.filename }), "success");
  }
  let layout = $state<"split" | "edit" | "preview">(session.user?.preferences.editor.layout ?? "split");
  let members = $state<string[]>([]);
  let advisors = $state<string[]>([]);
  let directory = $state<DirectoryUser[]>([]);
  let pickMember = $state("");
  let pickAdvisor = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    api.get<{ users: DirectoryUser[] }>("/users/directory").then(r => (directory = r.users), () => {});
  });

  const me = $derived(session.user?.id);
  const taken = $derived(new Set([me, ...members, ...advisors]));
  const memberChoices = $derived(directory.filter(u => !taken.has(u.id)));
  const advisorChoices = $derived(directory.filter(u => u.role === "professor" && !taken.has(u.id)));
  const nameOf = (id: string) => directory.find(u => u.id === id)?.name ?? "…";
  $effect(() => {
    if (pickMember) {
      members = [...members, pickMember];
      pickMember = "";
    }
  });
  $effect(() => {
    if (pickAdvisor) {
      advisors = [...advisors, pickAdvisor];
      pickAdvisor = "";
    }
  });
  const slugError = $derived(slug && (!STUDY_SLUG_RE.test(slug) || slug.length > 80) ? t("studies.field.slugInvalid") : null);
  const canSubmit = $derived(Boolean(title.trim()) && !slugError && !saving);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    saving = true;
    error = null;
    try {
      const result = await api.post<StudyDetail>("/studies", {
        title: title.trim(),
        ...(slug ? { slug } : {}),
        summary_md: summary,
        summary_format: format,
        ...(maturity ? { maturity } : {}),
        members: [...members.map(userId => ({ userId, role: "member" })), ...advisors.map(userId => ({ userId, role: "advisor" }))],
      });
      toasts.show(t("studies.new.created"), "success");
      await goto(`/studies/${result.study.slug}`);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head><title>{t("studies.new.title")} · Speech-AI Hub</title></svelte:head>

<a href="/studies" class="-ml-2 mb-3 inline-flex h-10 items-center gap-1.5 rounded-full px-2 text-[13px] font-medium text-ink-3 hover:text-ink"><ArrowLeft class="size-4" />{t("studies.back")}</a>
<PageHeader title={t("studies.new.title")} subtitle={t("studies.new.subtitle")} />

<div class="grid grid-cols-[minmax(0,1fr)] items-start gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
  <Card>
    <form id="study-form" class="flex flex-col gap-5" onsubmit={submit}>
      <TextField label={t("studies.field.title")} bind:value={title} maxlength={200} placeholder={t("studies.field.titlePlaceholder")} required />
      <TextField
        label={t("studies.field.slug")}
        bind:value={slug}
        maxlength={80}
        autocapitalize="off"
        spellcheck={false}
        error={slugError}
        hint={t("studies.field.slugHint", { slug: slug || "…" })}
      />
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-[13px] font-medium text-ink-2">{t("studies.field.summary")}</span>
          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onclick={() => (importOpen = true)}><FileInput />{t("docimport.title")}</Button>
            <Segmented bind:value={format} label={t("studies.field.format")} options={[{ value: "prose", label: t("studies.format.prose") }, { value: "bullets", label: t("studies.format.bullets") }]} />
          </div>
        </div>
        <MarkdownEditor bind:value={summary} bind:layout fontSize={session.user?.preferences.editor.fontSize ?? 15} label={t("studies.field.summary")} onImport={() => (importOpen = true)} />
        <DocImportSheet bind:open={importOpen} target={{ kind: "draft", purpose: "study_summary" }} style={format} onMarkdown={imported} />
        <p class="text-[12.5px] text-ink-3">{t("studies.field.summaryHint")}</p>
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("studies.maturity")}</span>
        <Select
          bind:value={maturity}
          label={t("studies.maturity")}
          class="w-full sm:w-80"
          options={[{ value: "", label: t("studies.maturity.none") }, ...MATURITIES.map(m => ({ value: m, label: t(`studies.maturity.${m}`), hint: t(`studies.maturity.${m}.hint`) }))]}
        />
      </div>

      {#snippet people(label: MessageKey, ids: string[], remove: (id: string) => void, choices: DirectoryUser[], add: MessageKey, pick: "member" | "advisor")}
        <div class="flex flex-col gap-2">
          <span class="text-[13px] font-medium text-ink-2">{t(label)}</span>
          {#if ids.length}
            <ul class="flex flex-wrap gap-2">
              {#each ids as id (id)}
                <li class="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-surface-2 pr-1 pl-1.5 text-[13.5px]">
                  <Avatar name={nameOf(id)} size={26} class="ring-0" />{nameOf(id)}
                  <button type="button" class="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("studies.field.remove", { name: nameOf(id) })} onclick={() => remove(id)}><X class="size-3.5" /></button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if choices.length}
            {#if pick === "member"}
              <Select bind:value={pickMember} label={t(add)} class="w-full sm:w-72" options={[{ value: "", label: `＋ ${t(add)}` }, ...choices.map(u => ({ value: u.id, label: u.name, hint: `@${u.username} · ${t(`role.${u.role}` as MessageKey)}` }))]} />
            {:else}
              <Select bind:value={pickAdvisor} label={t(add)} class="w-full sm:w-72" options={[{ value: "", label: `＋ ${t(add)}` }, ...choices.map(u => ({ value: u.id, label: u.name, hint: `@${u.username}` }))]} />
            {/if}
          {/if}
        </div>
      {/snippet}
      {@render people("studies.field.members", members, id => (members = members.filter(x => x !== id)), memberChoices, "studies.field.addMember", "member")}
      {@render people("studies.field.advisors", advisors, id => (advisors = advisors.filter(x => x !== id)), advisorChoices, "studies.field.addAdvisor", "advisor")}

      <p class="flex gap-2 rounded-2xl bg-surface-2 p-3.5 text-[12.5px] leading-relaxed text-ink-2"><Info class="mt-0.5 size-4 shrink-0 text-ink-3" />{t("studies.new.stagesHint")}</p>
      {#if error}<p class="text-[13px] text-danger" role="alert">{error}</p>{/if}
      <div class="flex justify-end gap-2">
        <Button variant="ghost" href="/studies">{t("action.cancel")}</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!canSubmit}>{t("studies.new.submit")}</Button>
      </div>
    </form>
  </Card>

  <!-- AI interview slot: the agent module replaces the placeholder button with the interview flow. -->
  <!-- Phones and tablets: the interview comes first (one tap instead of scrolling past the whole form). -->
  <section class="relative overflow-hidden rounded-[var(--radius-card)] hero-gradient p-5 text-hero-ink max-lg:order-first sm:p-6" aria-labelledby="ai-interview">
    <span class="inline-flex items-center gap-1.5 rounded-full bg-white/55 px-3 py-1 text-xs font-medium backdrop-blur dark:bg-black/25"><Sparkles class="size-3.5" />{t("studies.ai.interview")}</span>
    <h2 id="ai-interview" class="mt-4 font-display text-[28px] leading-tight">{t("studies.ai.interview")}</h2>
    <p class="mt-2 text-[13.5px] leading-relaxed opacity-80">{t("studies.ai.interviewHint")}</p>
    <StudyInterview
      members={() => [...members.map(userId => ({ userId, role: "member" as const })), ...advisors.map(userId => ({ userId, role: "advisor" as const }))]}
      onFill={plan => {
        title = plan.title;
        summary = plan.summary_md;
        format = plan.summary_format;
        maturity = plan.maturity ?? "";
        // On phones the form is below the interview now: bring it into view.
        document.getElementById("study-form")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }}
    />
  </section>
</div>
