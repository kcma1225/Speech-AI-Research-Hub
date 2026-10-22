<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import { ArrowDown, CloudOff, RotateCcw, Rocket, TriangleAlert, Wrench } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { prefersReducedMotion } from "svelte/motion";
  import AiGate from "#lib/components/ai/AiGate.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Composer from "./Composer.svelte";
  import AssistantTurn from "./AssistantTurn.svelte";
  import MessageItem from "./MessageItem.svelte";
  import QuestionNav from "./QuestionNav.svelte";
  import AttachButton from "./attach/AttachButton.svelte";
  import AttachmentTray from "./attach/AttachmentTray.svelte";
  import HashMenu from "./attach/HashMenu.svelte";
  import { AttachDraft } from "./attach/state.svelte.ts";
  import { namePasted } from "./attach/api.ts";
  import type { ChatSession } from "#lib/agent/chat.svelte.ts";
  import { contextLabel } from "#lib/agent/context.ts";
  import { contextWithRefs } from "#lib/agent/hashref.ts";
  import { answersByCall, askArgs } from "#lib/agent/ask.ts";
  import { buildTranscript, dropSupersededNotices } from "#lib/agent/transcript.ts";
  import { agentActivity } from "#lib/agent/activity.svelte.ts";
  import type { AgentSettings, Answer, Message, PageContext, StudyPlan, ToolCall } from "#lib/agent/types.ts";
  import { workflowsApi } from "#lib/workflows/api.ts";
  import { focusKey, revealAndPulse, waitForFocus, type FocusTarget } from "#lib/agent/focus.ts";
  import { parseAgentCommand } from "#lib/workflows/reduce.ts";

  /**
   * The chat: transcript (messages, tool timeline per step, consent cards), streaming answer, banners and composer.
   * Shared by /assistant, the global side panel (compact) and the study interview.
   */
  let {
    session,
    compact = false,
    context = null,
    placeholder,
    onPlan,
    onCreated,
    empty,
    autoStart,
    focus = null,
    onFocused,
  }: {
    session: ChatSession;
    compact?: boolean;
    /** Page context attached to the next message (the user can drop it). */
    context?: PageContext | null;
    placeholder?: string;
    /** Interview: called with each new study plan proposal. */
    onPlan?: (plan: StudyPlan | null, callId: string | null) => void;
    /** A new conversation was created by the first message. */
    onCreated?: (id: string) => void;
    empty?: Snippet<[(text: string) => void]>;
    /** Interview: first message sent automatically when the view starts empty. */
    autoStart?: string;
    /** Deep-linked card (lib/agent/focus.ts): scrolled to and pulsed once the transcript has loaded. */
    focus?: FocusTarget | null;
    /** The deep link was handled (`found` = the card was shown); the caller drops the URL parameter. */
    onFocused?: (found: boolean) => void;
  } = $props();

  let text = $state("");
  let input = $state<HTMLTextAreaElement | null>(null);
  let scroller = $state<HTMLElement | null>(null);
  let atBottom = $state(true);
  let unseen = $state(false);
  let dropContext = $state(false);
  let settings = $state<AgentSettings | null>(null);
  let draftAutopilot = $state<boolean | null>(null);
  let explainOpen = $state(false);

  // Attachments of the next message (「附加」 / @). Uploads need a conversation: created on demand, announced on send.
  let createdForUpload = false;
  const attachments = new AttachDraft(async () => {
    if (!session.id) {
      await session.create({ context: ctx, ...(draftAutopilot ? { autopilot: true } : {}) });
      createdForUpload = true;
    }
    return session.id!;
  });
  let attachOpen = $state(false);
  let attachConv: string | null = null;
  $effect(() => {
    const id = session.id;
    untrack(() => {
      if (attachConv && id !== attachConv) attachments.clear();
      attachConv = id;
    });
  });

  $effect(() => {
    const fromSession = session.settings;
    untrack(() => {
      if (fromSession) settings = fromSession;
      else if (!settings) api.get<{ settings: AgentSettings }>("/agent/settings").then((r) => (settings ??= r.settings), () => {});
    });
  });
  $effect(() => {
    // A new chat starts from the user's default.
    if (!session.conversation && settings && draftAutopilot === null) draftAutopilot = settings.autopilot_default;
  });

  const interview = $derived(session.mode === "interview");
  const autopilot = $derived(interview ? null : (session.conversation?.autopilot ?? draftAutopilot ?? false));
  const memoryAvailable = $derived(!!settings?.memory_enabled);
  const memoryOn = $derived(session.conversation ? session.conversation.memory_enabled : memoryAvailable);
  const run = $derived(session.run);
  const running = $derived(run?.status === "running");
  const acting = $derived(session.toolCalls.some((c) => c.status === "running" && c.approved_via === "autopilot"));
  const ctx = $derived(dropContext ? null : context);
  // 「#」 references rank the current study first: the page's, else the conversation's.
  const refStudy = $derived(ctx?.studySlug ?? ctx?.studyId ?? session.conversation?.context?.studyId ?? session.conversation?.study_id ?? null);
  const ctxLabel = $derived(contextLabel(ctx));
  // When an answer finishes, give the composer its focus back (desktop only: on phones it would pop the keyboard),
  // unless the user has moved on to something else on the page.
  let wasRunning = false;
  $effect(() => {
    const now = running || session.sending;
    if (wasRunning && !now && input && !matchMedia("(pointer: coarse)").matches) {
      const active = document.activeElement;
      if (!active || active === document.body || active === input || scroller?.contains(active)) input.focus({ preventScroll: true });
    }
    wasRunning = now;
  });
  // The page's own name for the context chip (「研究「低資源…」」), read from <title> = "<name> · Speech-AI Hub".
  let pageTitle = $state("");
  $effect(() => {
    if (!ctxLabel || typeof document === "undefined") return;
    const read = () => {
      const parts = document.title.split(" · ");
      pageTitle = parts.length > 1 ? parts.slice(0, -1).join(" · ").trim() : "";
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  });

  // Compact transcript (`lib/agent/transcript.ts`): user messages + one item per assistant turn (live plan, one
  // collapsed 「處理過程」 row, the answer, result chips, cards that need action). Question cards (`ask_user`) render as
  // cards; once answered, the answer message shows them.
  const answered = $derived(answersByCall(session.messages));
  const callById = $derived(new Map(session.toolCalls.map((c) => [c.id, c])));
  const replying = $derived(running || run?.status === "awaiting_llm" || session.sending);
  // Superseded workflow / goal status notices are dropped first (`dropSupersededNotices`: one partial summary per run,
  // the quiet status line only while it is the last thing in the chat).
  const items = $derived(buildTranscript(dropSupersededNotices(session.messages), session.toolCalls, { answered: new Set(answered.keys()), live: replying }));
  const lastUserSeq = $derived(session.messages.findLast((m) => m.role === "user")?.seq ?? -1);
  // 「重新產生」 on the latest assistant reply (after the last user message, nothing running).
  const regenerateId = $derived.by(() => {
    if (replying || run?.status === "awaiting_approval") return null;
    const last = session.messages.findLast((m) => m.role === "user" || (m.role === "assistant" && m.text));
    return last?.role === "assistant" && session.messages.some((m) => m.role === "user") ? last.id : null;
  });

  // Editing discards the replies after a message; warn when they include changes that were already applied.
  let tailConfirm = $state(false);
  let tailResolve: ((ok: boolean) => void) | null = null;
  $effect(() => {
    if (!tailConfirm && tailResolve) {
      tailResolve(false);
      tailResolve = null;
    }
  });
  function confirmTail(m: Message): Promise<boolean> {
    const seqOf = new Map(session.messages.map((x) => [x.id, x.seq]));
    const applied = session.toolCalls.some((c) => (seqOf.get(c.message_id) ?? -1) > m.seq && c.risk !== "read" && c.status === "done" && c.undo !== "done");
    if (!applied) return Promise.resolve(true);
    tailConfirm = true;
    return new Promise((resolve) => (tailResolve = resolve));
  }
  async function editMessage(m: Message, body: { text?: string; answers?: { tool_call_id: string; answers: Answer[] } }) {
    if (!(await confirmTail(m))) return false;
    try {
      await session.edit(m.id, body);
      atBottom = true;
      return true;
    } catch (e) {
      toasts.show(`${t("agent.editFailed")}：${(e as Error).message}`, "error");
      return false;
    }
  }
  async function regenerate() {
    const lastUser = session.messages.findLast((m) => m.role === "user");
    if (!lastUser || !(await confirmTail(lastUser))) return;
    try {
      await session.regenerate();
      atBottom = true;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function switchVersion(id: string) {
    try {
      await session.activate(id);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function answerCard(call: ToolCall, answers: Answer[]) {
    await session.answer(call.id, answers);
    atBottom = true;
    toBottom();
  }
  const lastUserAt = $derived(session.messages.findLast((m) => m.role === "user")?.created_at);

  // Interview: the latest finished proposal of the current branch (null when the branch has none).
  let lastPlan: string | null | undefined = undefined;
  $effect(() => {
    if (!onPlan) return;
    const latest = session.toolCalls.findLast((c) => c.tool === "propose_study_plan" && c.status === "done") ?? null;
    const id = latest?.id ?? null;
    if (id === lastPlan || session.loading) return;
    lastPlan = id;
    untrack(() => onPlan(latest ? (latest.args as unknown as StudyPlan) : null, id));
  });
  let started = false;
  $effect(() => {
    if (autoStart && !started && !session.id && !session.loading && !session.messages.length) {
      started = true;
      void send(autoStart);
    }
  });

  // Stick to the bottom only when the user is already there; otherwise offer a 「新內容」 pill.
  function onscroll() {
    if (!scroller) return;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    if (atBottom) unseen = false;
  }
  function toBottom(smooth = false) {
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !prefersReducedMotion.current ? "smooth" : "auto" });
    unseen = false;
  }
  $effect(() => {
    void session.messages.length;
    void session.toolCalls.map((c) => c.status).join();
    void session.streaming?.text.length;
    if (!scroller) return;
    if (atBottom) queueMicrotask(() => toBottom());
    else unseen = true;
  });

  // A new question card scrolls to its top (not the bottom), so the question and its first options are visible.
  const openCards = $derived(items.reduce((n, e) => n + (e.kind === "assistant" ? e.asks.length : 0), 0));
  let seenCards = 0;
  $effect(() => {
    const n = openCards;
    if (n > seenCards && scroller) {
      setTimeout(() => {
        const cards = scroller?.querySelectorAll<HTMLElement>("section.ask-card");
        const card = cards?.[cards.length - 1];
        if (card && scroller) {
          scroller.scrollTo({ top: Math.max(0, card.offsetTop - 12), behavior: "auto" });
          unseen = false;
        }
      }, 60);
    }
    seenCards = n;
  });

  // Deep link (「前往作答」 in the Agent overview, notifications, the jobs tray): once the transcript is in, wait for
  // the card (workflow cards load on their own), scroll to it and pulse it. Runs after the 「new question card」 scroll.
  const focusId = $derived(focus ? focusKey(focus) : null);
  let focusRun = 0;
  $effect(() => {
    const target = focus;
    const ready = !session.loading && session.messages.length > 0 && !!scroller;
    if (!target || !ready) return;
    const mine = ++focusRun;
    untrack(() => {
      void waitForFocus<HTMLElement>(scroller!, target, {
        cancelled: () => mine !== focusRun || !scroller,
        found: (el) => {
          atBottom = false;
          unseen = false;
          // Let the 「new question card」 scroll and late layout (workflow card body) settle first.
          setTimeout(() => {
            if (mine !== focusRun) return;
            revealAndPulse(el, scroller, prefersReducedMotion.current);
          }, 120);
        },
      }).then((found) => {
        if (mine !== focusRun) return;
        if (!found) toasts.show(t("agentRuns.focusMissing"));
        onFocused?.(found);
      });
    });
  });

  /** Pasted / dropped files: same path (validation, limits, progress chips) as the picker's upload. */
  async function attachFiles(files: File[]) {
    const r = await attachments.upload(files.map((f) => namePasted(f)));
    if ("error" in r && r.error) toasts.show(r.error, "error");
    if (r.skipped) toasts.show(t("attach.skipped", { n: r.skipped }), "error");
  }

  // 「交給 Agent」 / `/agent <task>`: a workflow (plan card → sub-agents → verification) instead of a one-shot reply.
  async function handToAgent(request: string) {
    if (!request.trim()) return void toasts.show(t("wf.handOffEmpty"), "error");
    const was = session.id;
    const sendCtx = contextWithRefs(ctx, attachments.contextRefs);
    try {
      if (!session.id) await session.create({ context: sendCtx, ...(draftAutopilot ? { autopilot: true } : {}) });
      await workflowsApi.create({ request: request.trim(), conversation_id: session.id!, ...(sendCtx ? { context: sendCtx } : {}) });
      void agentActivity.refresh();
      text = "";
      await session.reload();
      atBottom = true;
      toBottom();
      if (!was && session.id) onCreated?.(session.id);
    } catch (e) {
      toasts.show(`${t("wf.handOffFailed")}：${(e as Error).message}`, "error");
    }
  }

  async function send(value: string, intent?: "make_note") {
    const agentRequest = intent || interview ? null : parseAgentCommand(value);
    if (agentRequest !== null) return handToAgent(agentRequest);
    const was = session.id;
    if (!intent && attachments.busy) return void toasts.show(t("attach.waitUploads"), "error");
    if (!intent && attachments.items.some((i) => i.error)) return void toasts.show(t("attach.uploadErrors"), "error");
    const refs = intent ? [] : attachments.refs;
    // 「#」 study / task chips travel as page context.
    const sendCtx = intent ? ctx : contextWithRefs(ctx, attachments.contextRefs);
    const chips = !intent && attachments.items.length > 0;
    // The quick action keeps whatever the user is typing.
    if (!intent) text = "";
    try {
      if (!session.id && draftAutopilot) await session.create({ context: sendCtx, autopilot: true });
      await session.send(value, sendCtx, intent, refs);
      // The shell's 「N 個 Agent 執行中」 picks the new run up now, not at its next idle poll.
      setTimeout(() => void agentActivity.refresh(), 800);
      if (chips) attachments.clear();
      atBottom = true;
      toBottom();
      if ((!was || createdForUpload) && session.id) {
        createdForUpload = false;
        onCreated?.(session.id);
      }
    } catch (e) {
      if (!intent) text = value;
      toasts.show(`${t("agent.sendFailed")}：${(e as Error).message}`, "error");
    }
  }

  // 「整理成筆記」: the server turns the discussion (especially the user's questions) into a reading note via create_note.
  const canMakeNote = $derived(
    !interview && !!session.id && !replying && run?.status !== "awaiting_approval" && session.messages.some((m) => m.role === "assistant" && !!m.text),
  );
  function makeNote() {
    if (canMakeNote) void send(t("agent.makeNote.prompt"), "make_note");
  }

  // ---------------------------------------------------------------- question navigator
  let root = $state<HTMLElement | null>(null);
  let width = $state(0);
  /** Width of the transcript + composer column (the whole chat minus the question rail). */
  let mainWidth = $state(0);
  // The conversation column follows the space it has (wide screens use most of it; the side panel stays narrow).
  const columnMax = $derived(compact ? 760 : Math.round(Math.max(760, Math.min(1200, (mainWidth || width) * 0.88))));
  const questions = $derived(session.messages.filter((m) => m.role === "user" && !m.answers && m.text.trim()).map((m) => ({ id: m.id, text: m.text })));
  const questionKey = $derived(questions.map((q) => q.id).join(","));
  let currentQ = $state(-1);
  const navVariant = $derived(interview || questions.length < 2 ? null : compact ? "compact" : width >= 680 ? "rail" : "sheet");

  /** The question the reader is at: the last one whose top is above 45 % of the viewport. */
  function measure() {
    if (!scroller) return;
    const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.45;
    let at = -1;
    scroller.querySelectorAll<HTMLElement>("[data-question]").forEach((el, i) => {
      if (el.getBoundingClientRect().top <= line) at = i;
    });
    currentQ = at;
  }
  $effect(() => {
    void questionKey;
    const el = scroller;
    if (!el || !navVariant) return;
    // Fires whenever a question crosses the 45 % line (scrolling either way), not on every scroll event.
    const io = new IntersectionObserver(() => measure(), { root: el, rootMargin: "0px 0px -55% 0px", threshold: [0, 1] });
    void tick().then(() => {
      el.querySelectorAll("[data-question]").forEach((q) => io.observe(q));
      measure();
    });
    return () => io.disconnect();
  });
  function jump(i: number) {
    const q = questions[i];
    const el = q && scroller?.querySelector<HTMLElement>(`[data-msg-id="${q.id}"]`);
    if (!el || !scroller) return;
    scroller.scrollTo({ top: Math.max(0, el.offsetTop - 16), behavior: prefersReducedMotion.current ? "auto" : "smooth" });
    currentQ = i;
    atBottom = false;
  }
  function latest() {
    atBottom = true;
    toBottom(true);
  }
  function onWindowKey(e: KeyboardEvent) {
    if (!navVariant || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !root) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "End") return;
    const active = document.activeElement;
    const inside = !!active && root.contains(active);
    // The side panel reacts only when focus is in it; the page chat unless focus is in another chat.
    if (compact && !inside) return;
    if (!compact && !inside && active?.closest("[data-chat-root]")) return;
    if (!root.getClientRects().length) return;
    e.preventDefault();
    if (e.key === "End") latest();
    else if (e.key === "ArrowUp") jump(Math.max(0, currentQ - (currentQ >= 0 && isAboveTop(currentQ) ? 0 : 1)));
    else jump(Math.min(questions.length - 1, currentQ + 1));
  }
  /** The current question starts above the viewport top (reading its answer): 上一題 first goes back to it. */
  function isAboveTop(i: number) {
    const el = scroller?.querySelector<HTMLElement>(`[data-msg-id="${questions[i]?.id}"]`);
    return !!el && !!scroller && el.getBoundingClientRect().top < scroller.getBoundingClientRect().top - 8;
  }
  async function decide(call: ToolCall, decision: "approve" | "approve_conversation" | "deny", opts?: { reason?: string; editedArgs?: Record<string, unknown> }) {
    await session.decide(call, decision, opts);
  }
  async function setAutopilot(v: boolean) {
    if (v && !settings?.autopilot_explained) {
      explainOpen = true;
      return;
    }
    await applyAutopilot(v);
  }
  async function applyAutopilot(v: boolean) {
    try {
      if (session.conversation) await session.update({ autopilot: v });
      else draftAutopilot = v;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function setMemory(v: boolean) {
    try {
      if (session.conversation) await session.update({ memory_enabled: v });
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function retry() {
    try {
      await session.continue();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<div bind:this={root} bind:clientWidth={width} data-chat-root class="flex h-full min-h-0">
  <!-- Transcript and composer share one column, so the composer lines up with the messages; the question rail
       (wide screens) runs the full height beside both. -->
  <div bind:clientWidth={mainWidth} class="flex min-h-0 min-w-0 flex-1 flex-col">
  {#if navVariant === "compact"}
    <div class="flex justify-end px-3 pt-2"><QuestionNav {questions} current={currentQ} variant="compact" onJump={jump} onLatest={latest} /></div>
  {/if}
  {#if autopilot}
    <div class="flex justify-center px-3 pt-2">
      <span class="pill inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--pill-butter)] px-3 text-[12px] font-semibold text-[var(--pill-butter-ink)]" title={t("agent.autopilotHint")}><Rocket class="size-3.5" />{t("agent.autopilotOn")}</span>
    </div>
  {/if}

  <div class="relative flex min-h-0 flex-1">
  <div bind:this={scroller} {onscroll} class="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [scroll-behavior:auto]" role="log" aria-live="off" aria-label={t("agent.title")}>
    <!-- The floating 「n / N」 question button sits over the bottom of the list: room so the last card's buttons can scroll above it. -->
    <div class="mx-auto flex w-full flex-col gap-4 {compact ? 'px-3 py-4' : 'px-4 py-6 sm:px-6'} {navVariant === 'sheet' || (!compact && width < 680) ? 'pb-16!' : ''}" style:max-width="{columnMax}px">
      {#if session.loading && !session.messages.length}
        <div class="flex flex-col gap-3" aria-busy="true">
          <div class="ml-auto h-10 w-2/3 animate-pulse rounded-[20px] bg-surface-3"></div>
          <div class="h-20 w-5/6 animate-pulse rounded-[20px] bg-surface-2"></div>
        </div>
      {:else if session.error && !session.messages.length}
        <p class="rounded-2xl bg-danger-soft p-4 text-[13.5px] text-danger" role="alert">{t("agent.loadFailed")}：{session.error}</p>
      {:else if !session.messages.length && empty}
        {@render empty((v) => void send(v))}
      {/if}

      {#each items as item (item.key)}
        {#if item.kind === "message"}
          {@const m = item.message}
          {@const askCall = m.answers ? callById.get(m.answers.toolCallId) : undefined}
          <div data-msg-id={m.id} data-question={m.role === "user" && !m.answers && m.text.trim() ? "" : undefined} class="scroll-mt-4">
          <MessageItem
            message={m}
            canRemember={memoryAvailable && !interview}
            conversationId={session.id}
            onContinue={retry}
            busy={replying}
            ask={askCall ? askArgs(askCall) : null}
            onEdit={m.role === "user" && !m.answers ? (text) => editMessage(m, { text }) : undefined}
            onEditAnswers={m.role === "user" && m.answers ? (answers) => editMessage(m, { answers: { tool_call_id: m.answers!.toolCallId, answers } }) : undefined}
            onSwitch={m.versions ? (id) => void switchVersion(id) : undefined}
          />
          </div>
        {:else}
          <AssistantTurn
            turn={item}
            {compact}
            streaming={item.live ? session.streaming : null}
            {run}
            sinceFallback={lastUserAt ? new Date(lastUserAt).getTime() : Date.now()}
            canRemember={memoryAvailable && !interview}
            conversationId={session.id}
            busy={replying}
            deferredAsks={(item.messages.at(-1)?.seq ?? Infinity) < lastUserSeq}
            focusKey={focusId}
            onDecide={decide}
            onAnswer={answerCard}
            onContinue={retry}
            onRegenerate={item.final && item.final.id === regenerateId ? () => void regenerate() : undefined}
          />
        {/if}
      {/each}

      {#if run && run.status !== "running" && run.autopilot_writes > 0 && !interview}
        <p class="ml-11 text-[12.5px] text-ink-3">{t("agent.autopilotActing", { n: run.autopilot_writes })}</p>
      {/if}

      {#if run?.status === "awaiting_llm"}
        <div class="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface-2 p-3.5 text-[13px] text-ink-2" role="status">
          <CloudOff class="size-4 shrink-0 text-ink-3" />
          <span class="min-w-0 flex-1">{session.toolCalls.some((c) => c.run_id === run.id && c.status === "done" && c.approved_via === "user") ? t("agent.awaitingLlmApproved") : t("agent.awaitingLlm")}</span>
          <button type="button" class="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-medium" onclick={retry}><RotateCcw class="size-3.5" />{t("agent.retry")}</button>
          <button type="button" class="inline-flex min-h-10 items-center rounded-full px-3 text-[12.5px] text-ink-3 hover:text-ink" onclick={() => session.cancel()}>{t("agent.stop")}</button>
        </div>
      {:else if run?.status === "failed"}
        <div class="flex flex-wrap items-center gap-3 rounded-2xl bg-danger-soft p-3.5 text-[13px] text-danger" role="alert">
          <TriangleAlert class="size-4 shrink-0" />
          <span class="min-w-0 flex-1"><span class="font-medium">{t("agent.failed")}</span>{#if run.error?.error}：{run.error.error}{/if}{#if run.error?.hint}<span class="mt-0.5 block text-[12.5px] opacity-80">{run.error.hint}</span>{/if}</span>
          <button type="button" class="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-surface px-3.5 text-[12.5px] font-medium text-ink" onclick={retry}><RotateCcw class="size-3.5" />{t("agent.retry")}</button>
        </div>
      {/if}
    </div>
  </div>
  {#if navVariant === "sheet"}
    <div class="absolute right-3 bottom-3 z-10"><QuestionNav {questions} current={currentQ} variant="sheet" onJump={jump} onLatest={latest} /></div>
  {/if}
  </div>

  {#if unseen && !atBottom && !openCards}
    <div class="pointer-events-none relative z-10 -mt-12 flex justify-center pb-2">
      <button type="button" class="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-medium shadow-pop" onclick={() => toBottom(true)}><ArrowDown class="size-3.5" />{t("agent.newContent")}</button>
    </div>
  {/if}

  <div data-chat-bottom style:max-width="{columnMax}px" class="relative mx-auto w-full {compact ? 'px-3 pb-3' : 'px-4 pb-4 sm:px-6'} pb-[max(12px,env(safe-area-inset-bottom))]">
    {#if session.id && !session.live && !session.loading}
      <p class="mb-1.5 text-center text-[12px] text-ink-3" role="status">{t("agent.offline")}</p>
    {/if}
    <AiGate role="assistant">
      {#if !interview}<HashMenu textarea={input} bind:value={text} draft={attachments} study={refStudy} disabled={!input} />{/if}
      <Composer
        bind:value={text}
        bind:ref={input}
        busy={running || session.sending}
        {placeholder}
        {autopilot}
        {acting}
        memory={interview ? null : { on: memoryOn, available: memoryAvailable }}
        contextLabel={ctxLabel}
        contextTitle={ctxLabel === "paper" && !ctx?.path?.startsWith("/library/") ? "" : pageTitle}
        onSend={send}
        onStop={() => void session.cancel()}
        onAutopilot={(v) => void setAutopilot(v)}
        onMemory={(v) => void setMemory(v)}
        onClearContext={() => (dropContext = true)}
        onMakeNote={interview ? undefined : makeNote}
        onAgent={interview ? undefined : (v) => void handToAgent(v)}
        agentCompact={compact}
        makeNoteDisabled={!canMakeNote}
        attach={interview ? undefined : attachBar}
        tray={interview ? undefined : attachTray}
        onAt={interview ? undefined : () => (attachOpen = true)}
        onFiles={interview ? undefined : (files) => void attachFiles(files)}
      />
      {#snippet fallback()}
        <div class="flex items-start gap-3 rounded-[24px] border border-dashed border-line-2 bg-surface-2 p-4 text-[13px] text-ink-2" role="status">
          <Wrench class="mt-0.5 size-4 shrink-0 text-ink-3" />
          <div><p class="font-medium text-ink">{t("agent.maintenance")}</p><p class="mt-0.5 text-ink-3">{t("agent.maintenanceHint")}</p></div>
        </div>
      {/snippet}
    </AiGate>
  </div>
  </div>
  {#if navVariant === "rail"}
    <QuestionNav {questions} current={currentQ} variant="rail" wide={width >= 960} onJump={jump} onLatest={latest} />
  {/if}
</div>

{#snippet attachBar()}<AttachButton draft={attachments} context={ctx} conversationId={session.id} {compact} bind:open={attachOpen} />{/snippet}
{#snippet attachTray()}<AttachmentTray draft={attachments} />{/snippet}

<ConfirmDialog
  bind:open={tailConfirm}
  title={t("agent.editConfirmTitle")}
  description={t("agent.editConfirmHint")}
  confirmLabel={t("agent.editConfirm")}
  onConfirm={() => {
    const r = tailResolve;
    tailResolve = null;
    r?.(true);
  }}
/>

<ConfirmDialog
  bind:open={explainOpen}
  danger={false}
  title={t("agent.autopilotConfirmTitle")}
  description={t("agent.autopilotExplain")}
  confirmLabel={t("agent.autopilotConfirm")}
  onConfirm={async () => {
    const r = await api.patch<{ settings: AgentSettings }>("/agent/settings", { autopilot_explained: true });
    settings = r.settings;
    await applyAutopilot(true);
  }}
/>

<style>
  .pill {
    animation: fade 200ms ease-out;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
