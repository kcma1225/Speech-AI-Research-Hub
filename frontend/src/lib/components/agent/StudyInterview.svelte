<script lang="ts">
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { ClipboardList, Plus, RotateCcw, Sparkles, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import AiGate from "#lib/components/ai/AiGate.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import DatePicker from "#lib/components/ui/DatePicker.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { ChatSession } from "#lib/agent/chat.svelte.ts";
  import type { StudyPlan } from "#lib/agent/types.ts";
  import ChatView from "./ChatView.svelte";

  /**
   * 「AI 訪談」 on /studies/new: an `interview` conversation asks one question at a time and ends with a study plan
   * (summary + stages + milestones). The user edits the plan, then either fills the form or creates the study here
   * (stages and milestones are written through the normal study API).
   */
  let { members = () => [], onFill }: { members?: () => { userId: string; role: "member" | "advisor" }[]; onFill: (plan: StudyPlan) => void } = $props();

  const session = new ChatSession("interview");
  let started = $state(false);
  let plan = $state<StudyPlan | null>(null);
  let reviewOpen = $state(false);
  let creating = $state(false);
  let box = $state<HTMLElement | null>(null);
  // On phones the interview sits below the long form: bring it into view when it starts.
  $effect(() => {
    if (started && box) box.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  $effect(() => () => session.destroy());

  function onPlan(p: StudyPlan) {
    const raw = JSON.parse(JSON.stringify(p)) as StudyPlan;
    // Models sometimes double-escape newlines in tool arguments ("…\\n…").
    const summary = typeof raw.summary_md === "string" && !raw.summary_md.includes("\n") ? raw.summary_md.replace(/(?:\\r)?\\n/g, "\n") : raw.summary_md;
    plan = { ...raw, summary_md: summary, stages: raw.stages?.length ? raw.stages : [{ name: "題目發想" }], milestones: raw.milestones ?? [] };
    untrack(() => (reviewOpen = true));
  }
  function restart() {
    session.reset();
    plan = null;
    started = false;
    queueMicrotask(() => (started = true));
  }

  async function create() {
    if (!plan || !plan.title.trim()) return;
    creating = true;
    try {
      const detail = await api.post<{ study: { slug: string }; stages: { id: string; name: string; position: number; is_current: boolean }[] }>("/studies", {
        title: plan.title.trim(),
        summary_md: plan.summary_md,
        summary_format: plan.summary_format,
        members: members(),
      });
      const slug = detail.study.slug;
      let partial = false;
      const stageIds: Record<string, string> = {};
      const existing = [...detail.stages].sort((a, b) => a.position - b.position);
      const wanted = plan.stages.filter((s) => s.name.trim()).slice(0, 20);
      for (const [i, s] of wanted.entries()) {
        try {
          const cur = existing[i];
          if (cur) {
            await api.patch(`/studies/${slug}/stages/${cur.id}`, { name: s.name.trim().slice(0, 60), description: (s.description ?? "").slice(0, 2000) });
            stageIds[s.name.trim()] = cur.id;
          } else {
            const r = await api.post<{ stages: { id: string; name: string }[] }>(`/studies/${slug}/stages`, { name: s.name.trim().slice(0, 60), description: (s.description ?? "").slice(0, 2000) });
            const made = r.stages.at(-1);
            if (made) stageIds[s.name.trim()] = made.id;
          }
        } catch {
          partial = true;
        }
      }
      for (const extra of existing.slice(wanted.length)) {
        if (extra.is_current) continue;
        await api.del(`/studies/${slug}/stages/${extra.id}`).catch(() => (partial = true));
      }
      for (const m of plan.milestones ?? []) {
        if (!m.title.trim()) continue;
        await api
          .post(`/studies/${slug}/milestones`, { title: m.title.trim().slice(0, 200), due_on: m.due_on || null, stage_id: (m.stage && stageIds[m.stage]) || null })
          .catch(() => (partial = true));
      }
      toasts.show(partial ? t("agent.interview.partial") : t("agent.interview.created"), partial ? "error" : "success");
      reviewOpen = false;
      await goto(`/studies/${slug}`);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      creating = false;
    }
  }
</script>

{#if !started}
  <div class="mt-5">
    <AiGate role="assistant">
      <Button variant="primary" onclick={() => (started = true)}><Sparkles />{t("agent.interview.start")}</Button>
    </AiGate>
  </div>
{:else}
  <div bind:this={box} class="mt-5 flex h-[min(560px,70dvh)] flex-col overflow-hidden rounded-[22px] border border-line bg-canvas text-ink">
    <ChatView {session} compact placeholder={t("agent.interview.placeholder")} autoStart={t("agent.interview.opening")} {onPlan} />
  </div>
  <div class="mt-3 flex flex-wrap gap-2">
    {#if plan}<Button variant="primary" onclick={() => (reviewOpen = true)}><ClipboardList />{t("agent.interview.plan")}</Button>{/if}
    <Button variant="ghost" onclick={restart}><RotateCcw />{t("agent.interview.restart")}</Button>
  </div>
{/if}

<Sheet bind:open={reviewOpen} title={t("agent.interview.plan")} description={t("agent.interview.planHint")} side="right">
  {#if plan}
    <div class="flex flex-col gap-5">
      <TextField label={t("agent.interview.title")} bind:value={plan.title} maxlength={200} />
      <div class="flex flex-col gap-2">
        <Segmented bind:value={plan.summary_format} label={t("studies.field.format")} options={[{ value: "prose", label: t("studies.format.prose") }, { value: "bullets", label: t("studies.format.bullets") }]} />
        <Textarea label={t("agent.interview.summary")} bind:value={plan.summary_md} rows={8} />
      </div>
      {#if plan.advisors?.length}<p class="text-[12.5px] text-ink-3">{t("agent.interview.advisors", { names: plan.advisors.join("、") })}</p>{/if}

      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 text-[13px] font-medium text-ink-2">{t("agent.interview.stages")}</legend>
        {#each plan.stages as stage, i (i)}
          <div class="flex items-start gap-2">
            <span class="mt-2.5 w-5 shrink-0 text-right text-[12px] text-ink-3 tabular-nums">{i + 1}</span>
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <TextField bind:value={stage.name} maxlength={60} aria-label={t("agent.interview.stageName")} />
              {#if stage.description}<p class="text-[12px] text-ink-3">{stage.description}</p>{/if}
            </div>
            <Button size="icon" variant="ghost" aria-label={t("agent.interview.removeStage", { name: stage.name })} disabled={plan.stages.length <= 1} onclick={() => plan!.stages.splice(i, 1)}><X /></Button>
          </div>
        {/each}
        <Button size="sm" variant="ghost" class="self-start" onclick={() => plan!.stages.push({ name: "" })}><Plus />{t("agent.interview.addStage")}</Button>
      </fieldset>

      <fieldset class="flex flex-col gap-3">
        <legend class="mb-1 text-[13px] font-medium text-ink-2">{t("agent.interview.milestones")}</legend>
        {#each plan.milestones ?? [] as m, i (i)}
          <div class="flex flex-col gap-2 rounded-2xl bg-surface-2 p-3">
            <div class="flex items-start gap-2">
              <TextField class="min-w-0 flex-1" bind:value={m.title} maxlength={200} aria-label={t("agent.interview.milestoneTitle")} />
              <Button size="icon" variant="ghost" aria-label={t("agent.interview.removeMilestone", { name: m.title })} onclick={() => plan!.milestones!.splice(i, 1)}><X /></Button>
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <DatePicker bind:value={() => m.due_on ?? "", (v) => (m.due_on = v || null)} label={t("agent.interview.due")} clearable placeholder={t("agent.interview.noDue")} />
              <Select
                bind:value={() => m.stage ?? "", (v) => (m.stage = v || undefined)}
                label={t("agent.interview.stages")}
                options={[{ value: "", label: t("agent.interview.noStage") }, ...plan.stages.filter((s) => s.name.trim()).map((s) => ({ value: s.name.trim(), label: s.name.trim() }))]}
              />
            </div>
          </div>
        {/each}
        <Button size="sm" variant="ghost" class="self-start" onclick={() => (plan!.milestones ??= []).push({ title: "", due_on: null })}><Plus />{t("agent.interview.addMilestone")}</Button>
      </fieldset>
    </div>
  {/if}
  {#snippet footer()}
    <Button
      variant="ghost"
      onclick={() => {
        if (plan) onFill(plan);
        reviewOpen = false;
      }}>{t("agent.interview.useInForm")}</Button
    >
    <Button variant="primary" loading={creating} disabled={!plan?.title.trim()} onclick={create}>{t("agent.interview.create")}</Button>
  {/snippet}
</Sheet>
