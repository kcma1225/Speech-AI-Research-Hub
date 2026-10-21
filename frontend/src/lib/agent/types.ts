/** API shapes of /api/agent/* (backend/src/agent/views.ts). */
export type PageContext = {
  path?: string;
  studyId?: string;
  studySlug?: string;
  noteId?: string;
  deckId?: string;
  page?: number;
  meetingId?: string;
  paperId?: string;
};

export type ConversationMode = "chat" | "interview";

export type Conversation = {
  id: string;
  title: string;
  mode: ConversationMode;
  context: PageContext & { studyTitle?: string };
  study_id: string | null;
  autopilot: boolean;
  memory_enabled: boolean;
  compacted: boolean;
  created_at: string;
  updated_at: string;
};

export type ConversationListItem = Conversation & { last_text: string | null; run_status: RunStatus | null; pending: number };

export type RunStatus = "running" | "awaiting_approval" | "awaiting_llm" | "done" | "cancelled" | "failed";

export type Run = {
  id: string;
  conversation_id: string;
  status: RunStatus;
  step: number;
  max_steps: number;
  tainted: boolean;
  taint_sources: string[];
  autopilot_writes: number;
  tokens: { in: number; out: number };
  stop_reason: string | null;
  error: { error: string; code?: string; hint?: string } | null;
  llm_waits: number;
  next_retry_at: string | null;
  started_at: string;
  finished_at: string | null;
};

export type Message = {
  id: string;
  seq: number;
  run_id: string | null;
  role: "user" | "assistant" | "notice" | "compaction";
  text: string;
  reasoning: string;
  status: "complete" | "cancelled";
  page_context: (PageContext & { studyTitle?: string }) | null;
  kind: string | null;
  memories: { id: string; content: string }[];
  /** `ask_user` answers sent as this user turn. */
  answers?: StoredAnswers | null;
  /** Ids of every version of this user message (oldest first) when it was edited / regenerated. */
  versions?: string[] | null;
  /** References attached to this user message (`components/agent/attach`). */
  attachments?: import("#lib/components/agent/attach/types.ts").Attachment[];
  hidden?: boolean;
  created_at: string;
};

export type QuestionType = "single_choice" | "multi_choice" | "short_text" | "long_text" | "number" | "date" | "scale" | "yes_no";
export type AskQuestion = {
  id: string;
  prompt: string;
  type: QuestionType;
  options?: { value: string; label: string; description?: string }[];
  allow_other?: boolean;
  required?: boolean;
  placeholder?: string;
  scale_labels?: string[];
};
export type AskArgs = { intro?: string; questions: AskQuestion[] };
export type AnswerValue = string | number | boolean | string[] | null;
export type Answer = { id: string; value?: AnswerValue; other?: string; skipped?: boolean };
export type StoredAnswers = { toolCallId: string; answers: Answer[] };

export type Risk = "read" | "write" | "destructive";
export type ToolStatus = "pending_approval" | "approved" | "denied" | "running" | "done" | "failed" | "cancelled" | "expired";
export type ApprovalReason = "write" | "destructive" | "memory" | "tainted" | "outbound" | "autopilot_limit";

export type ToolLink = { label: string; url: string; kind?: string };

export type ToolCall = {
  id: string;
  run_id: string;
  message_id: string;
  step: number;
  position: number;
  tool: string;
  title: string;
  title_en: string;
  risk: Risk;
  always_ask: boolean;
  grantable: boolean;
  open_world: boolean;
  status: ToolStatus;
  approved_via: "user" | "conversation_grant" | "autopilot" | null;
  approval_reason: ApprovalReason | null;
  decided_at: string | null;
  deny_reason: string | null;
  summary: string;
  target: { studyId: string | null; studySlug?: string; label: string; url?: string } | null;
  args: Record<string, unknown>;
  edited: boolean;
  result: { data: unknown; links: ToolLink[]; source: string | null } | null;
  error: string | null;
  /** 「復原」 for calls that ran without a card: "available" until used, then "done". */
  undo?: "available" | "done" | null;
  undone_at?: string | null;
  provenance: string[];
  created_at: string;
  finished_at: string | null;
};

export type AgentSettings = { memory_enabled: boolean; autopilot_default: boolean; autopilot_explained: boolean };

export type ConversationDetail = {
  conversation: Conversation;
  messages: Message[];
  toolCalls: ToolCall[];
  run: Run | null;
  grants: { tool: string; scope: string }[];
  settings: AgentSettings;
  resumeFrom: number;
};

export type Memory = {
  id: string;
  scope: "global" | "study";
  study_id: string | null;
  study: { id: string; slug: string; title: string } | null;
  content: string;
  source: "agent" | "user";
  source_conversation_id: string | null;
  source_conversation_title: string | null;
  source_deleted: boolean;
  created_at: string;
  updated_at: string;
};

export type McpToken = { id: string; name: string; prefix: string; scopes: ("read" | "suggest")[]; created_at: string; last_used_at: string | null; expires_at: string | null };

export type StudyMaturity = "exploring" | "problem_defined" | "method_first" | "continuation" | "assigned" | "well_defined";

export type StudyPlan = {
  maturity?: StudyMaturity;
  open_questions?: string[];
  first_steps?: { title: string }[];
  title: string;
  summary_md: string;
  stages: { name: string; description?: string }[];
  milestones?: { title: string; due_on?: string | null; stage?: string }[];
  advisors?: string[];
};
