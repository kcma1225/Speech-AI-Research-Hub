<script lang="ts">
  import { untrack } from "svelte";
  import { ExternalLink } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import TranscriptPanel from "#lib/components/meetings/TranscriptPanel.svelte";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import type { MeetingDetail } from "#lib/meetings/types.ts";
  import { viewer } from "#lib/agent/viewer.ts";
  import type { ViewerEntry } from "#lib/agent/viewer-state.svelte.ts";
  import ViewerLink from "./ViewerLink.svelte";
  import { fmtClock, poll } from "./util.ts";

  /**
   * A meeting: transcript with its player (click a line to seek; `focus.time` seeks) and the per-study drafts
   * (read here; confirming stays on the meeting page, where only members of that study may do it).
   */
  let { entry }: { entry: ViewerEntry } = $props();
  const id = untrack(() => entry.ref.id);
  let detail = $state<MeetingDetail | null>(null);
  let error = $state<string | null>(null);
  let tab = $state<"transcript" | "drafts">("transcript");
  let panel = $state<TranscriptPanel | null>(null);

  async function load() {
    try {
      const next = await api.get<MeetingDetail>(`/meetings/${id}`);
      const changed = detail && JSON.stringify(detail.drafts.map((d) => d.updated_at)) !== JSON.stringify(next.drafts.map((d) => d.updated_at));
      detail = next;
      viewer.setTitle(entry.ref, next.meeting.title);
      if (changed) viewer.markUpdated(entry.ref);
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    const rev = viewer.revisionOf(entry.ref);
    untrack(() => {
      void load();
      if (rev && viewer.follow) tab = "drafts";
    });
  });
  const busy = (d: MeetingDetail | null) => !!d && [d.jobs.transcribe, d.jobs.analyze].some((j) => j && (j.status === "queued" || j.status === "running"));
  $effect(() => poll(async () => {
    await load();
    return busy(detail) ? 5000 : 30_000;
  }, 8000));

  let lastNonce = -1;
  $effect(() => {
    const e = entry;
    const ready = !!panel;
    untrack(() => {
      if (!ready || e.nonce === lastNonce) return;
      lastNonce = e.nonce;
      if (e.focus.time !== undefined && !e.auto) {
        tab = "transcript";
        panel?.seek(e.focus.time);
      }
    });
  });
  const tone = (s: string) => (s === "confirmed" ? "mint" : s === "dismissed" ? "stone" : "butter");
</script>

{#if error && !detail}
  <p class="m-4 rounded-2xl bg-danger-soft p-4 text-[13px] text-danger" role="alert">{error}</p>
{:else if !detail}
  <div class="grid h-full place-items-center"><Spinner class="size-5 text-ink-3" /></div>
{:else}
  {@const d = detail}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-3 pb-2">
      <Segmented guardIgnore bind:value={tab} label={t("viewer.meeting.view")} options={[{ value: "transcript", label: t("viewer.meeting.transcript") }, { value: "drafts", label: t("viewer.meeting.drafts", { n: d.drafts.length }) }]} />
      <span class="text-[12px] text-ink-3">{formatDate(d.meeting.held_at)} · {t(`meet.status.${d.meeting.status}` as MessageKey)}</span>
      <span class="min-w-0 flex-1"></span>
      <ViewerLink href={`/meetings/${id}`} icon={ExternalLink} label={t("viewer.meeting.open")} />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto border-t border-line px-3 py-3">
      <div class={tab === "transcript" ? "" : "hidden"}>
        {#if d.transcript}
          <TranscriptPanel bind:this={panel} detail={d} onChanged={async (next) => {
            if (next) detail = next;
            else await load();
          }} />
        {:else}
          <p class="rounded-xl bg-surface-2 px-3 py-6 text-center text-[13px] text-ink-3">{t("viewer.meeting.noTranscript")}</p>
        {/if}
      </div>
      {#if tab === "drafts"}
        <div class="flex flex-col gap-3">
          {#if !d.drafts.length}<p class="rounded-xl bg-surface-2 px-3 py-6 text-center text-[13px] text-ink-3">{t("meet.draft.none")}</p>{/if}
          {#each d.drafts as draft (draft.id)}
            <article class="rounded-2xl border border-line bg-surface p-4">
              <header class="mb-2 flex flex-wrap items-center gap-2">
                <h3 class="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{draft.study_title}</h3>
                <Pill tone={tone(draft.status)} size="sm">{t(`meet.draft.${draft.status}` as MessageKey)}</Pill>
                {#if draft.origin === "edited" && draft.edited_by_name}<span class="text-[11.5px] text-ink-3">{t("meet.draft.edited", { name: draft.edited_by_name })}</span>{/if}
              </header>
              {#if draft.summary_md}
                <p class="mt-2 text-[12px] font-medium text-ink-3">{t("meet.draft.summary")}</p>
                <MarkdownView source={draft.summary_md} fontSize={13.5} />
              {/if}
              {#if draft.feedback_md}
                <p class="mt-3 text-[12px] font-medium text-ink-3">{t("meet.draft.feedback")}</p>
                <MarkdownView source={draft.feedback_md} fontSize={13.5} />
              {/if}
              {#if draft.proposed_tasks.length}
                <p class="mt-3 text-[12px] font-medium text-ink-3">{t("meet.draft.tasks")}</p>
                <ul class="mt-1 flex flex-col gap-1 text-[13.5px] text-ink">
                  {#each draft.proposed_tasks as task (task.id)}<li class="flex gap-2"><span class="mt-[9px] size-1.5 shrink-0 rounded-full bg-ink-3"></span><span>{task.title}{#if task.due}<span class="ml-1.5 text-[12px] text-ink-3">{task.due}</span>{/if}</span></li>{/each}
                </ul>
              {/if}
              {#if draft.evidence.length && d.transcript}
                <div class="mt-3 flex flex-wrap gap-1.5">
                  {#each draft.evidence.slice(0, 6) as ev, i (i)}
                    <button type="button" class="inline-flex min-h-10 max-w-full items-center gap-1.5 rounded-full border border-line px-3 text-[12px] text-ink-2 hover:border-line-2" title={ev.quote} onclick={() => ((tab = "transcript"), panel?.seek(ev.start))}>
                      <span class="font-medium tabular-nums">{fmtClock(ev.start)}</span><span class="truncate">{ev.quote}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
