import { api } from "#lib/api.ts";
import type { AgentSettings, Answer, Conversation, ConversationDetail, ConversationMode, Message, PageContext, Run, ToolCall } from "./types.ts";

export type Streaming = { runId: string; text: string; reasoning: string; inputs: { index: number; name: string; title: string }[]; startedAt: number };

/**
 * One conversation in the browser: loads the persisted state, then follows the SSE event log
 * (`/api/agent/conversations/:id/events`, resumable with Last-Event-ID). The loop itself runs on the server, so
 * closing the tab never stops a run; reloading resumes exactly where it was (pending approvals included).
 * Text deltas are buffered and flushed once per animation frame.
 */
export class ChatSession {
  id = $state<string | null>(null);
  conversation = $state<Conversation | null>(null);
  messages = $state<Message[]>([]);
  toolCalls = $state<ToolCall[]>([]);
  run = $state<Run | null>(null);
  grants = $state<{ tool: string; scope: string }[]>([]);
  settings = $state<AgentSettings | null>(null);
  streaming = $state<Streaming | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  sending = $state(false);
  /** SSE connection state: lost connections reconnect by themselves. */
  live = $state(false);

  private source: EventSource | null = null;
  private pending = { text: "", reasoning: "" };
  private frame = 0;
  private openSeq = 0;

  constructor(readonly mode: ConversationMode = "chat") {}

  get busy() {
    return this.run?.status === "running" || this.sending;
  }
  get pendingCalls() {
    return this.toolCalls.filter((c) => c.status === "pending_approval");
  }

  async open(id: string) {
    const seq = ++this.openSeq;
    this.close();
    this.id = id;
    this.loading = true;
    this.error = null;
    try {
      const d = await api.get<ConversationDetail>(`/agent/conversations/${id}`);
      if (seq !== this.openSeq) return;
      this.conversation = d.conversation;
      this.messages = d.messages;
      this.toolCalls = d.toolCalls;
      this.run = d.run;
      this.grants = d.grants;
      this.settings = d.settings;
      this.streaming = null;
      this.connect(d.resumeFrom);
    } catch (e) {
      if (seq === this.openSeq) this.error = (e as Error).message;
    } finally {
      if (seq === this.openSeq) this.loading = false;
    }
  }

  /** Forgets the current conversation (a new chat starts on the next send). */
  reset() {
    this.openSeq++;
    this.close();
    this.id = null;
    this.conversation = null;
    this.messages = [];
    this.toolCalls = [];
    this.run = null;
    this.grants = [];
    this.streaming = null;
    this.error = null;
  }

  async create(opts: { context?: PageContext | null; autopilot?: boolean; title?: string } = {}) {
    const r = await api.post<{ conversation: Conversation }>("/agent/conversations", { mode: this.mode, ...(opts.context ? { context: opts.context } : {}), ...(opts.autopilot !== undefined ? { autopilot: opts.autopilot } : {}), ...(opts.title ? { title: opts.title } : {}) });
    await this.open(r.conversation.id);
    return r.conversation;
  }

  /** `intent: "make_note"` (「整理成筆記」) asks the server to synthesise the conversation into a reading note. */
  async send(text: string, context: PageContext | null = null, intent?: "make_note", attachments: { kind: string; id: string; project_id?: string; version?: string }[] = []) {
    this.sending = true;
    try {
      if (!this.id) await this.create({ context });
      const r = await api.post<{ message: Message; run: Run }>(`/agent/conversations/${this.id}/messages`, { text, ...(context ? { context } : {}), ...(intent ? { intent } : {}), ...(attachments.length ? { attachments } : {}) });
      this.upsertMessage(r.message);
      this.setRun(r.run);
      // Pending cards of a superseded step are denied by the server; the events update them.
    } finally {
      this.sending = false;
    }
  }

  /** Answers an `ask_user` card (a special user turn). */
  async answer(toolCallId: string, answers: Answer[]) {
    if (!this.id) return;
    this.sending = true;
    try {
      const r = await api.post<{ message: Message; run: Run }>(`/agent/conversations/${this.id}/messages`, { answers: { tool_call_id: toolCallId, answers } });
      this.upsertMessage(r.message);
      this.setRun(r.run);
    } finally {
      this.sending = false;
    }
  }

  /**
   * Edits a user message (text, or the answers of a card): the server cancels the running reply, keeps the later
   * messages as the previous version and answers again. The transcript is reloaded (the branch changed).
   */
  async edit(messageId: string, body: { text?: string; answers?: { tool_call_id: string; answers: Answer[] } }) {
    if (!this.id) return;
    this.sending = true;
    try {
      await api.post(`/agent/conversations/${this.id}/messages/${messageId}/edit`, body);
      await this.reload();
    } finally {
      this.sending = false;
    }
  }

  /** 「重新產生」 the latest reply. */
  async regenerate() {
    if (!this.id) return;
    this.sending = true;
    try {
      await api.post(`/agent/conversations/${this.id}/regenerate`);
      await this.reload();
    } finally {
      this.sending = false;
    }
  }

  /** ‹ 1/2 ›: shows another version of a user message (and the replies that followed it). */
  async activate(messageId: string) {
    if (!this.id) return;
    await api.post(`/agent/conversations/${this.id}/messages/${messageId}/activate`);
    await this.reload();
  }

  /** Re-reads the conversation after a branch change (no ghost events: the stream restarts after the new state). */
  async reload() {
    if (this.id) await this.open(this.id);
  }

  async decide(call: ToolCall, decision: "approve" | "approve_conversation" | "deny", opts: { reason?: string; editedArgs?: Record<string, unknown> } = {}) {
    const r = await api.post<{ toolCall: ToolCall }>(`/agent/tool-calls/${call.id}/decision`, { decision, ...(opts.reason ? { reason: opts.reason } : {}), ...(opts.editedArgs ? { edited_args: opts.editedArgs } : {}) });
    this.upsertCall(r.toolCall);
  }

  async cancel() {
    if (!this.id) return;
    const r = await api.post<{ run: Run | null }>(`/agent/conversations/${this.id}/cancel`);
    if (r.run) this.setRun(r.run);
  }

  async continue() {
    if (!this.id) return;
    const r = await api.post<{ run: Run }>(`/agent/conversations/${this.id}/continue`);
    this.setRun(r.run);
  }

  async update(patch: { title?: string; autopilot?: boolean; memory_enabled?: boolean }) {
    if (!this.id) return;
    const r = await api.patch<{ conversation: Conversation }>(`/agent/conversations/${this.id}`, patch);
    this.conversation = r.conversation;
  }

  destroy() {
    this.openSeq++;
    this.close();
  }

  // ---------------------------------------------------------------- events

  private close() {
    this.source?.close();
    this.source = null;
    this.live = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending = { text: "", reasoning: "" };
  }

  private connect(after: number) {
    if (!this.id || typeof EventSource !== "function") return;
    const es = new EventSource(`/api/agent/conversations/${this.id}/events?after=${after}`);
    this.source = es;
    es.onopen = () => (this.live = true);
    es.onerror = () => (this.live = false);
    const on = (type: string, fn: (data: any) => void) => es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data)));
    on("message", (d) => this.upsertMessage(d.message));
    on("tool_call", (d) => this.upsertCall(d.toolCall));
    on("run", (d) => this.setRun(d.run));
    on("conversation", (d) => (this.conversation = d.conversation));
    // Another tab (or this one) edited / switched versions: the transcript changed under us.
    on("branch", () => void this.reload());
    on("step_start", (d) => {
      this.flush();
      this.streaming = { runId: d.runId, text: "", reasoning: "", inputs: [], startedAt: Date.now() };
    });
    on("step_discarded", () => {
      this.pending = { text: "", reasoning: "" };
      this.streaming = null;
    });
    on("text", (d) => this.buffer(d.runId, "text", d.text));
    on("reasoning", (d) => this.buffer(d.runId, "reasoning", d.text));
    on("tool_input", (d) => {
      this.ensureStreaming(d.runId);
      this.streaming!.inputs = [...this.streaming!.inputs.filter((x) => x.index !== d.index), { index: d.index, name: d.name, title: d.title }];
    });
  }

  private ensureStreaming(runId: string) {
    if (!this.streaming || this.streaming.runId !== runId) this.streaming = { runId, text: "", reasoning: "", inputs: [], startedAt: Date.now() };
  }

  private buffer(runId: string, kind: "text" | "reasoning", text: string) {
    this.ensureStreaming(runId);
    this.pending[kind] += text;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (!this.streaming || (!this.pending.text && !this.pending.reasoning)) return;
    this.streaming = { ...this.streaming, text: this.streaming.text + this.pending.text, reasoning: this.streaming.reasoning + this.pending.reasoning };
    this.pending = { text: "", reasoning: "" };
  }

  private upsertMessage(m: Message) {
    if (m.hidden) return;
    if (m.role === "assistant" && this.streaming?.runId === m.run_id) {
      this.pending = { text: "", reasoning: "" };
      this.streaming = null;
    }
    const i = this.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) this.messages[i] = m;
    else this.messages = [...this.messages, m].sort((a, b) => a.seq - b.seq);
  }

  private upsertCall(c: ToolCall) {
    const i = this.toolCalls.findIndex((x) => x.id === c.id);
    if (i >= 0) this.toolCalls[i] = c;
    else this.toolCalls = [...this.toolCalls, c];
  }

  private setRun(r: Run) {
    if (this.run && this.run.id !== r.id && new Date(r.started_at) < new Date(this.run.started_at)) {
      // An older run's update (e.g. superseded): only keep it if it is the current one.
      return;
    }
    this.run = r;
    if (r.status !== "running") {
      this.flush();
      this.streaming = null;
    }
  }
}
