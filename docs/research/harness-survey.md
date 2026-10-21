# Research: open-source agent harnesses — what to copy into our assistant and workflow engine

Survey of how open-source agent harnesses run the loop, delegate to sub-agents, plan, verify, recover and compact
context, read from their source code (shallow clones on 2026-10-21, read-only; nothing from them was executed).
Companion to `docs/research/agent-harness.md` (approvals, consent UI, injection), which this does not repeat.
Section 4 lists what was implemented in `backend/src/agent/**` (with tests and a live check); section 5 is the hand-off
for the workflow engine (`src/workflows/`, agent O).

Licences: openai/codex, cline, block/goose, google-research/harness2 = Apache-2.0; sst/opencode, OpenHands
software-agent-sdk, SWE-agent, deepseek-harness = MIT; claude-agent-sdk-typescript = proprietary (ideas only). Nothing
was copied; every implementation below is our own code with the idea source named in a comment.

| Repo (URL as given → resolved) | Commit | What it is |
|---|---|---|
| `openai/codex` | `af91f6e` | Rust CLI agent (`codex-rs/`): turn loop, tool router, sandbox/approvals, compaction, sub-agents, review |
| `google-research/harness2` (exists) | `1cfe254` | Python research framework that *optimises* a harness (prompts/skills/sub-agents) per task: Propose–Probe–Compose |
| `deepseek-ai/deepseek-harness` (exists) | `687f282e` | TypeScript "everything is a plugin" agent on Cordis; web UI, sub-agents, compaction, spill store |
| `sst/opencode` → `anomalyco/opencode` | `4d59657` | TS agent, now the Effect-based v2 core (`packages/core/src`) |
| `All-Hands-AI/OpenHands` → frontend only; core in `OpenHands/software-agent-sdk` | `f78800b` / `0996c33` | Python agent SDK: stuck detector, condensers, task tool, critic |
| `cline/cline` | `e9dafbb` | VS Code agent, now an SDK (`sdk/packages/*`): plan/act/yolo, mistake tracker, checkpoints |
| `block/goose` → `aaif-goose/goose` | `7143ddd` | Rust agent, operation state machine, recipes with retry checks, delegate sub-agents |
| `SWE-agent/SWE-agent` | `3ea751c` | ACI design, history processors, RetryAgent + reviewer/chooser loops |
| `anthropics/claude-agent-sdk-typescript` | `9c59e06` | Only README/CHANGELOG (no type definitions shipped) |

All URLs the user named exist. Paths below are relative to each repo root.

## 1. Per-harness notes

### 1.1 openai/codex (`codex-rs/`)
- **Turn loop** (`core/src/session/turn.rs:173` `run_turn`, loop at :461): drain queued "steer" input → sample → run tools →
  `needs_follow_up = model_needs_follow_up || has_pending_input` (:610). Any tool call (or a tool error returned as text)
  forces a follow-up (`core/src/stream_events_utils.rs:368,436`); no tool call ends the turn. **No max-turn cap**
  ("as long as compaction works well … we shouldn't worry about being in an infinite loop", :681). Stop hooks can veto the
  end by injecting a prompt (:743–760).
- **Errors/retries**: stream retries 5, request retries 4, backoff 200 ms·2^(n−1) ±10 % (`model-provider-info/src/lib.rs:66–75`,
  `async-utils/src/backoff.rs:7–17`); `ResponseIncomplete` (cut off) is *not* retryable and ends the turn
  (`protocol/src/error.rs:421`); unknown tool → "unsupported call: {name}" back to the model (`core/src/tools/registry.rs:965`).
- **Parallel tools**: one `RwLock` per turn; tools with `supports_parallel` take a read lock, others the write lock
  (`core/src/tools/parallel.rs:51,213`). Parallel: exec, view_image, MCP read-only, web search; serialized: `apply_patch`,
  `update_plan`, spawn/close agent. Outputs are appended in call order (`FuturesOrdered`, `turn.rs:2974,3373`).
- **Truncation**: 10 000 tokens (bytes/4) per tool output, **middle cut 50/50 head/tail** (`utils/string/src/truncate.rs:6,142`),
  header "Warning: truncated output (original token count: N)" (`utils/output-truncation/src/lib.rs:32`); only the live
  history is truncated, the rollout keeps ≤ 64 KiB.
- **Approvals**: `untrusted | on-request | granular | never` (`protocol/src/protocol.rs:1097`); sandbox first, escalate on
  denial with a reason (`core/src/tools/orchestrator.rs:395,474–527`); `ApprovedForSession` cache keyed by the serialized
  request (`core/src/tools/sandboxing.rs:42–118`); auto-reviewer circuit breaker after 3 consecutive denials
  (`ext/guardian-reviewer/src/circuit_breaker.rs:3–6`).
- **Compaction**: auto at min(config, 90 % of window) (`protocol/src/openai_models.rs:529`); prompt
  `prompts/templates/compact/prompt.md` ("CONTEXT CHECKPOINT COMPACTION … handoff summary for another LLM … progress and
  key decisions / constraints and preferences / what remains / critical data"); summary prefixed with
  `compact/summary_prefix.md` ("Another language model started to solve this problem …"). After compaction it keeps the
  **most recent user messages up to 20 000 tokens** + summary, drops assistant/tool items (`core/src/compact.rs:63,710–800`);
  if compaction itself overflows it drops the oldest item and retries ("trim from the beginning to preserve cache", :358).
- **`update_plan`** (`core/src/tools/handlers/plan_spec.rs:46`, `plan.rs`): `{explanation?, plan:[{step,status}]}`, "At most
  one step can be in_progress at a time", returns "Plan updated", emits a `PlanUpdate` event the UI renders; no state kept
  by the harness. Prompt (`models-manager/prompt.md:52–121`): no plans for simple tasks, "Do not repeat the full contents
  of the plan after an update_plan call", 5–7-word steps, exactly one in_progress, explicit good vs bad plan examples.
- **Sub-agents** (`core/src/tools/handlers/multi_agents/`): `spawn_agent / send_message / wait_agent / close_agent`; depth 1
  ("Agent depth limit reached. Solve the task yourself.", `spawn.rs:75–79`), ≤ 6 threads; `fork_turns all|none`; roles
  `explorer` ("trust the explorer results without additional verification") and `worker` ("explicit ownership … disjoint
  write set") (`core/src/agent/role.rs:359–388`); the child's last message is mailed to the parent on completion
  (`core/src/agent/control/completion.rs:27`). Guidance: "Do not spawn sub-agents unless the user … explicitly asks".
- **Review mode** (`core/src/tasks/review.rs:99–143`): one-shot child thread with `REVIEW_PROMPT`, no collab/web tools,
  approval `never`; output `findings[{title, body, confidence_score, priority 0–3, code_location}]` + `overall_correctness`,
  `overall_confidence_score`; parsed as JSON → first `{…}` → plain text (:193).
- **Goals** (`ext/goal`): auto-continue when idle with `templates/goals/continuation.md`: no-progress check, "The audit
  must prove completion, not merely fail to find obvious remaining work", blocked only after 3 consecutive turns on the
  same blocker; budget-limited goals get a wrap-up prompt.
- **Prompt** (`models-manager/prompt.md`): sections Personality / AGENTS.md / Preambles / Planning / Task execution /
  Validating / Progress updates / Final answer / Tool guidelines; "keep going until the query is completely resolved …
  Do NOT guess or make up an answer" (:125); preambles 8–12 words, grouped, none for trivial reads.

### 1.2 google-research/harness2
Not a runtime harness but a harness *optimiser*: a harness is a file tree (system prompt, guardrails, memory, tool
guidance, skills, sub-agent defs, scripts, plugins; `third_party/jb_runner/harness_baseline_oc/harness.yaml`) rendered
into OpenCode/Codex (`AGENTS.md`, `.opencode/skills`, `.opencode/agent/*.md`; `benchmarks/jobbench.py:455–496`).
- **Propose–Probe–Compose** (`harness2/core/prompts.py`): two editors with disjoint mandates — *invariant* ("how the agent
  WORKS": tool error → bounded fallback, repetition → script, triggered workflow → skill, ignored rule → hook,
  :347–370) and *domain* ("what a PRACTITIONER knows", :372–407); each candidate is rolled out once; a composer MERGEs,
  ADOPTs one or KEEPs_BASE (:893–961) with explicit evidence weighting ("A defect in 1/k is noise … a candidate that
  produced nothing is UNSAFE", :916–931). Evidence = full rollout files; "Cite the specific trajectory moment behind
  every change" (`core/context.py:521–546`).
- **Cost ordering for harness edits** (`prompts.py:129–146`): "ALWAYS-ON PROSE IS THE EXPENSIVE OPTION … prefer SKILL >
  SCRIPT > SUBAGENT > PLUGIN > ALWAYS-ON TEXT … If you add always-on text, cut something else"; always-on caps 24 000
  chars (OpenCode) / 8 000 (Codex) (`substrate/opencode.py:50`, `substrate/codex.py:41–74`).
- **Reference-free selection judge** (`prompts.py:1040–1102`, `core/selection.py:71–112`): anonymised, seeded shuffle;
  ordered criteria DELIVERY → CONFORMANCE → FIDELITY (against source) → INTERNAL CONSISTENCY → OPERATIONAL FITNESS →
  FINISH; must name the runner-up.
- **Experience library** (`core/library.py:43–181`): lessons `{cue, lesson, evidence, confidence}` or `NO_ENTRY`; edits
  tagged `helped|hurt|no observed effect|confounded`; "Too generic is useless ('be thorough'); too specific never fires".
- **Eval** (`core/judge.py`, `core/report.py:108–109`): per-task `n_passed/n_criteria`; Partial = mean fraction, All-pass =
  share of tasks with every criterion passed; judge failure = `None` (excluded, not zero).

### 1.3 deepseek-ai/deepseek-harness
- Loop `packages/core/agent-loop/src/agent.ts:298–398` (`while(true)`, no step cap); waterfall hooks `agent/pre-step`,
  `agent/request-error`, `tools/pre-execute|post-execute`, `agent/turn-stopping`.
- Retries `packages/llm/llm-retry`: 5 for `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT`, 500 ms→10 s; a
  `max-tokens` finish **drops every tool call** ("a truncated call is unsafe to execute",
  `docs/subsystems/llm-streaming.md:368`).
- Parallel tools `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10` with "exclusive" calls as barriers (`src/constants.ts:6`).
- Truncation in two layers: spill policy head+tail at 12 500 tokens with the full text in a spill store
  (`packages/spill/spill-policy`), and a history pruner for old results (> 8192 chars → head 4096 + tail 1024,
  `compaction-tool-result-pruner/src/config.ts:7–14`).
- **Repeat-tool reminder** with escalating thresholds [3, 5, 8]: gentle note, then a detailed one naming tool + args
  (`guard/repeat-tool-reminder/src/index.ts:70–86`).
- Compaction at 0.8 × window, verbatim tail 0.16, tool pairs never split, summariser is the last user message after the
  replayed prefix (KV-cache reuse), sections Request/Concepts/Files/Errors/Pending/Current/Next/Critical
  (`packages/compaction/compaction-basic/src/summarizer.ts:24–68`).
- **Cache-stable prompts**: tool catalogue identical across modes; volatile facts (cwd, policies) as a user-role
  "runtime context" after history, not in the system prompt (`core/system-prompt/src/index.ts:131–180`).
- Sub-agents `subagent` / `subagent_fork` (fork keeps model → KV cache), `maxDepth 1`; "Ralph" loop = fresh worker per
  round with JSON handoff `status continue|complete|blocked` (`packages/experimental/tool-ralph/src/index.ts:150–174`).

### 1.4 opencode (v2 core, `packages/core/src`)
- Loop `session/runner/llm.ts:185–192`; continues only after local tool calls. **Max steps**: on the last step it appends
  `MAX_STEPS_PROMPT` ("CRITICAL - MAXIMUM STEPS REACHED … Tools are disabled … Respond with text only" + summary of work
  and remaining tasks, `max-steps.ts:1–16`) and sets `toolChoice: "none"` **while keeping tool definitions for the cache**
  (`llm.ts:220–238`).
- Output limit: synthetic "Your last response hit the output token limit … Break the remaining work into smaller pieces"
  (`llm.ts:37–38`), fails after two consecutive length stops; interrupted stream → "Continue from where you left off
  without repeating" (:34–35).
- Retry `model-retry.ts:22–40`: exponential 2 s capped 10 s, 10 retries, retry-after honoured ≤ 15 min.
- `subagent` tool (`tool/plugin/subagent.ts`): fresh child session ("include all relevant context"), depth limit 1,
  built-ins `general` (no nested subagent / question) and `explore` (read-only); last assistant text returned as
  `<subagent state="completed">…</subagent>`, "Subagent completed without a text response." when empty.
- `todowrite` (`tool/plugin/todo.ts`, `tool/todowrite.txt`): full list per call, statuses incl. `cancelled`, "Use it
  proactively when a task has 3 or more distinct steps … Skip it for a single simple task"; the list is just the latest
  call's input (revert rolls it back for free).
- Plan mode (`plugin/plan.ts:14–96`): persisted `<system-reminder>` on enter/leave, re-inserted when compaction removed it.
- Compaction (`session/compaction.ts:93–276`): trigger window − max(15 %, 16 000); keep 15 000 tokens verbatim;
  incremental summary template Objective / Requirements / Decisions / Work State / Next Move / Relevant Files / Important
  Context; "Preserve exact file paths, symbols, commands, error strings"; one nudge if the template headings are missing.
- Tool output: 2 000 lines / 50 KiB head-only, full output written to a file referenced in the marker (`tool-output.ts:13–92`).
- Doom loop (3 identical calls → ask) survives only in docs (`web/src/content/docs/permissions.mdx:168`).

### 1.5 OpenHands software-agent-sdk
- **Stuck detector** (`openhands-sdk/openhands/sdk/conversation/stuck_detector.py`, thresholds `conversation/types.py:136–161`):
  scans ≤ 20 events after the last user message; same action+observation ×4; same action+error ×3 → **one nudge**
  ("You've called `{tool}` with the same arguments 3 times … review the error message and either correct the arguments
  or try a different approach", :213–243), > 3 → STUCK; monologue ×3; alternating A/B over 6.
- Limits: `max_iteration_per_run = 500`, optional `max_budget_per_run` across all LLMs incl. condenser.
- **Condenser** `LLMSummarizingCondenser` (`context/condenser/llm_summarizing_condenser.py:64–347`): `max_size 240`
  (default preset 80), `keep_first 2/4`; triggers REQUEST (context-window error → `CondensationRequest`, hard), TOKENS
  (hard), EVENTS (soft); keeps half; cut points never split tool pairs; on failure of a hard condensation it shrinks every
  event ×0.8 and retries ≤ 5. Summary sections USER_CONTEXT / TASK_TRACKING / COMPLETED / PENDING / CURRENT_STATE
  ("If the events contain ANY task-tracking, you MUST include a TASK_TRACKING section … preserve exact task IDs").
- **Context-window error → condense and retry** (`agent/agent.py:828–871`).
- **Task tool** (`openhands-tools/openhands/tools/task/`): `{description (3–5 words), prompt, subagent_type, resume?}`;
  child = new conversation, no parent history, own iteration/budget counters, cost written back to the parent
  (`manager.py:263–508`); non-finished child → error + "Partial result:"; resumable by task id. Older `DelegateTool`:
  ≤ 5 children run in threads and joined.
- `task_tracker` `{command view|plan, task_list[{title, notes, status todo|in_progress|done}]}`: "Limit active work to ONE
  task … Never mark done when tests are failing".
- Response classification (`agent/response_dispatch.py:45–400`): plain text ends the run; empty / reasoning-only gets one
  nudge "Your last response did not include a function call or a message".
- **Critic + iterative refinement** (`critic/`, `agent/critic_mixin.py:76–138`): score = P(success); refine when < 0.6, ≤ 3
  iterations, follow-up "The task appears incomplete … verify each requirement is met. List what's working and what needs
  fixing, then complete the task."
- Truncation: middle cut, terminal 30 000 chars, editor 16 000, any text block 50 000 (`utils/truncate.py`).
- Risk: every non-read-only tool gets an LLM-filled `security_risk` field; `ConfirmRisky(threshold HIGH,
  confirm_unknown)`; "Always escalate to HIGH if sensitive data leaves the environment".

### 1.6 cline (SDK rewrite)
- Modes `plan | act | yolo` = tool presets; plan mode keeps shell but hard-blocks edits (`sdk/packages/core/src/extensions/tools/presets.ts:20–160`).
  `switch_to_act_mode` "only after the user has explicitly approved the plan in a message sent AFTER you presented it".
- **Mistake tracker** (`runtime/safety/mistake-tracker.ts`): `api_error | invalid_tool_call | tool_execution_failed`, max 6
  consecutive (CLI 3), then stop with "Session state was preserved. Send a new prompt to resume" or a recovery notice
  ("retry with a different approach, validate tool parameters before calls"). **Loop detection** identical calls: soft
  warning at 3, hard at 5 (`runtime/safety/loop-detection.ts:114–115`).
- Retries: model request/stream 3, empty response 3 × 250 ms (`llms/src/providers/ai-sdk.ts:1096`, `middleware/retry-empty-response.ts:96`).
- Compaction: trigger 0.9, target 0.7 (0.5 for long chats), keep 20 000 recent tokens, never cut at a tool-result-only
  message (`extensions/context/compaction-shared.ts:15–400`); duplicate file reads → "[outdated - see the latest file
  content]", rewritten in batches ≥ 64 KiB to keep the prefix cache (`session/services/message-builder.ts:38–50`).
- Completion: `submit_and_exit({summary, verified})` "set verified to true only if your tool output shows the
  requirements are met"; `requireCompletionTool` guard injects "[SYSTEM] This run is not complete until you call …".
- Checkpoints: private git refs per run + transactional restore (`hooks/checkpoint-hooks.ts`, `session/checkpoint-restore.ts`).
- Parallel: adjacent tools marked `parallel` via `Promise.all`, sequential ones are barriers (`agents/src/agent-runtime.ts:2343`).

### 1.7 goose
- Operation state machine (`crates/goose/src/agents/state_machine_builder.rs`), max turns 1000; from 50 % of the budget a
  `<turn-budget>n/max used</turn-budget>` block is injected ("As the budget gets low, become more direct",
  `state_machine/ops_maxturns.rs:9–22`, `agents/moim.rs`).
- All tool calls of a message run concurrently; provider retry 3 × (1 s ×2, ≤ 30 s).
- `delegate` sub-agents (`platform_extensions/summon.rs:451–1437`): no nesting, forced `response` schema (default
  `{summary}`), ≤ 5 concurrent, results delivered as hidden "Subagent {id} completed: …" messages.
- **Recipes with retry checks** (`agents/types.rs:3–60`, `state_machine/ops_retry.rs:172–279`): after a turn, shell checks
  run; any failure → `on_failure`, conversation reset to the kickoff message, retry ≤ `max_retries`.
- `recipe__final_output` validates JSON-schema output; ending without it → "You MUST call the `final_output` tool NOW"
  (`agents/final_output_tool.rs:12–151`).
- Todo `todo_write` stored as session state, re-injected every turn ("items need not be closed out").
- Large tool responses > 200 000 chars → temp file + pointer (`agents/large_response_handler.rs`).
- Smart-approve: annotation read-only → allow, else one batched LLM judge that treats args as untrusted data
  (`permission/permission_judge.rs:41–88`).

### 1.8 SWE-agent
- ACI: YAML tool docs with signatures; windowed viewer (100 lines, overlap 2); **lint-gated edit** that undoes an edit
  introducing new flake8 errors and says "Your changes have NOT been applied … DO NOT re-run the same failed edit"
  (`tools/windowed_edit_linting/bin/edit`).
- History processors (`sweagent/agent/history_processors.py`): `last_n_observations` (n=5, "Old environment output: (N
  lines omitted)", keeps the first; `polling` to limit cache busts), `closed_window`, `cache_control` (last 2).
- Requery on format errors ≤ 3 with the bad output + error in a *temporary* history (`agents.py:1062–1218`);
  "Your last output did not use any tool calls!" message; autosubmit on every abnormal exit.
- `review_on_submit_m`: first `submit` returns a review checklist + the diff, the second submits — a cheap self-review gate.
- **RetryAgent** (`agents.py:257–439`, `agent/reviewer.py`): `ScoreRetryLoop` (reviewer samples 5×, score = mean − k·std,
  stop at `accept_score`, `max_attempts`, cost) and `ChooserRetryLoop` (N attempts, one chooser call picks the best).
- Observation cap 100 000 chars head-only; LLM retries 20 with 10–120 s random-exponential wait.

### 1.9 claude-agent-sdk-typescript (CHANGELOG only)
Subagents with `tools/prompt/model/maxTurns`, default depth 1 and concurrency 20; hooks `PreToolUse` (`ask`,
`updatedInput`), `PostToolUse` (`updatedToolOutput`), `Stop/SubagentStop` with `additionalContext` (continue the turn);
`maxTurns`, `maxBudgetUsd`; TodoWrite deprecated in favour of `TaskCreate/Update/List` (accumulate by id); a pluggable
`sessionStore` with a Postgres reference adapter (append-only `(session_id, subpath, entry jsonb)`).

## 2. Comparison

| | codex | opencode | OpenHands SDK | cline | goose | deepseek-h. | SWE-agent | **ours (after this change)** |
|---|---|---|---|---|---|---|---|---|
| Step cap | none (compaction) | optional per agent | 500 | — | 1000 | none | cost/calls | 25 + wrap-up reply |
| At the cap | — | tool-less summary (`toolChoice none`) | error | — | ask to continue | — | autosubmit | tool-less summary, then 「繼續」 |
| Repeat / stuck | none in core | doc only (3 → ask) | 4 same, 3 same error (nudge), monologue 3, A/B 6 | 3 soft / 5 hard | inspector (off) | reminders 3/5/8 | — | note at 2nd identical read, hard stop at 3rd; failures: note at 3, stop at 6 |
| Empty / cut-off reply | ends turn (not retryable) | length → "break into smaller pieces" (×2) | one nudge | 3 retries | EmptyResponse op | retry EMPTY_RESPONSE ×5 | requery ×3 | 1 retry with nudge + bigger budget, else notice |
| Context overflow | trim oldest + retry | compact (`overflow`), shrink 0.7/0.5/0.35 | CondensationRequest → hard condense | — | compact ≤ 2× | compact on request-error | exit_context | forced compaction + 1 retry |
| Tool-output cap | 10 k tok, middle 50/50 | 50 KiB head + file | 30 k middle | 8 k | 200 k → file | 12.5 k head+tail → spill | 100 k head | 12 k chars head 70 / tail 30 |
| Old results | dropped at compaction | (pruning removed) | condensed | dedupe outdated reads | pair summaries (opt-in) | head 4096 + tail 1024 | last 5 kept | placeholders naming tool + args |
| Compaction summary | handoff prompt + last 20 k user tokens | incremental, 7 sections | 5 sections + task tracking | 5 sections | JSON 9 fields | 8 sections | — | 5-section handoff + carried plan |
| Plan / todo | `update_plan` (events) | `todowrite` (flag) | `task_tracker` | removed | `todo_write` (state) | `todo` | — | `update_plan` + checklist UI |
| Parallel tools | RwLock (parallel-safe) | — | — | `parallel` adjacents | all concurrent | 10, barriers | 1 call/step | reads ≤ 4 concurrent, open-world after |
| Completion check | goal audit prompt, Stop hooks | — | critic (score < 0.6, ≤ 3) | submit `verified`, completion guard | recipe checks, final_output | — | submit review gate, reviewer loops | deterministic claim/plan review, 1 correction |
| Sub-agents | depth 1, ≤ 6, explorer/worker | depth 1, general/explore | task tool, own budget, resumable | spawn_agent, teams ≤ 2 | delegate ≤ 5, schema output | depth 1, fork for cache | RetryAgent attempts | (workflow engine, §5) |

## 3. Ranked ideas for us

Effort S/M/L; risk = chance of regressions or user-visible oddities.

| # | Idea | Why / evidence | Where | Effort | Risk | Status |
|---|---|---|---|---|---|---|
| 1 | `update_plan` checklist tool | multi-step chats lose track; every major harness has one (codex `plan_spec.rs`, opencode `todowrite.txt`, OpenHands `task_tracker`, deepseek `tool-todo`) | `tools/plan.ts`, `PlanChecklist.svelte`, prompt `WORK_RULES` | S | low | **done** |
| 2 | Deterministic completion review (claimed writes vs. reality, unfinished plan) | hallucinated "已建立" is our worst UX failure; cline `verified`/completion guard, OpenHands critic, codex goal audit; deterministic = free | `guards.ts completionReview`, `runtime.modelStep` | M | low–med (false positives cost one extra call) | **done** |
| 3 | Consecutive-failure note (3) and stop (6) | OpenHands action_error nudge at 3, cline mistake limit 6 / loop 3–5; weak models loop on bad ids | `guards.ts`, `runtime.failureGuard` | S | low | **done** |
| 4 | Graduated repeat handling (note on the 2nd identical read, stop on the 3rd) | deepseek repeat reminders, cline soft/hard | `runtime.proposeCalls` | S | low | **done** |
| 5 | Tool-less wrap-up reply at the step / time limit | opencode `MAX_STEPS_PROMPT` + `toolChoice none`; a bare stop notice wastes the run | `runtime.loop` | S | low | **done** |
| 6 | Head+tail truncation of tool results | codex/OpenHands/deepseek cut the middle; totals and `next_offset` live at the end | `guards.truncateMiddle`, `prompt.capResult` | S | low | **done** |
| 7 | Concurrent read tools (≤ 4), open-world reads after | codex RwLock, goose/cline concurrency; papers + study + notes reads often come together | `runtime.proposeCalls` | S | low (taint order preserved) | **done** |
| 8 | Handoff-style compaction summary + plan carried + named placeholders | codex/opencode/OpenHands templates; OpenHands "MUST include TASK_TRACKING"; SWE-agent "Old output (N lines omitted)" | `prompt.SUMMARY_SYSTEM`, `toModelMessages`, `runtime.contextMessages` | S | low | **done** |
| 9 | Overflow-driven compaction + 1 retry | our token estimate is rough; OpenHands CondensationRequest, opencode overflow recovery | `runtime.modelStep` / `contextMessages(force)` | S | low | **done** |
| 10 | Prompt `WORK_RULES` (plan quality examples, persistence, preambles, self-check) | codex prompt.md sections | `prompt.ts` | S | low | **done** |
| 11 | Turn-budget hint near the step cap (`<turn-budget>` from 50 %) | goose MOIM | user-turn tail (cache-safe) | S | low | queued |
| 12 | Batch-stable result clearing (clear old results in chunks, not every step) | cline 64 KiB batching, SWE-agent `polling`; protects prompt cache on long chats | `toModelMessages` keepFrom rounding | S | low | queued |
| 13 | Volatile context out of the system prompt (date, memories) into a trailing runtime block | deepseek runtime context, OpenHands dynamic tier; `today()` currently changes the system prompt daily, memories per edit | `systemPrompt` / `contextMessages` | M | med (prompt shape change) | queued |
| 14 | Spill store for big results: keep the full result in `tool_calls.result` and let the model page it with a generic `read_tool_result {call_id, offset}` | opencode / deepseek / goose spill files | new read tool | M | low | queued |
| 15 | Offline eval set: scripted fixtures + reference-free judge (harness2 criteria order) on the cheapest model, Partial / All-pass metrics | harness2 `judge.py`/`report.py`; we have no regression signal for prompt edits | `backend/test/eval/` (opt-in) | M | none (offline) | queued |
| 16 | LLM critic for write-heavy turns (role `fast`, score + issues, ≤ 1 refinement) | OpenHands critic, SWE-agent reviewer; deterministic review covers the main failure already | after #2 | M | med (latency/cost) | not now |
| 17 | Ask-mode (plan-only) toggle: read tools + `update_plan`, writes hidden behind a "proposal" | cline plan/act, opencode plan agent | conversation flag | M | med | not now (workflows cover plan approval) |

## 4. What was implemented (assistant runtime) and how it was validated

Files: `backend/src/agent/guards.ts` (new), `backend/src/agent/tools/plan.ts` (new), `backend/src/agent/runtime.ts`,
`backend/src/agent/prompt.ts`, `backend/src/agent/tools/index.ts`, `frontend/src/lib/components/agent/PlanChecklist.svelte`
(new), `frontend/src/lib/components/agent/ToolTimeline.svelte`, `frontend/src/lib/i18n/agent-plan.ts` (new),
`frontend/src/lib/messages.ts` (module registration), `docs/architecture.md` (Agent loop steps 2/3/4/7/8, reply quality,
`update_plan`).

- `update_plan {explanation?, plan[1–12]{step, status}}`, ≤ 1 `in_progress` (zod refine), read/no card/not on MCP; the SPA
  renders the newest call of a step as a checklist (strike-through done, pulsing current, `n/N 完成`).
- Completion review: once per model step in chat mode; facts = all tool calls since the last user message on the current
  branch (approvals and 「繼續」 resume the same turn); claims = 已/了/passive patterns with a fixed object list
  (筆記, 待辦, 簡報, 文獻, 建議…) + "I've created…" — offers (「要不要我幫你建立」) and paper prose are not matched;
  the correction prompt includes the draft and may continue with tools; an empty corrected reply keeps the draft.
- Failure guard / repeat note / wrap-up / head+tail cap / concurrent reads / forced compaction as in §3.

Validation:
- `backend/test/agent-guards.unit.test.ts` (11 tests: truncation, streaks, claim regexes incl. negatives, review cases,
  plan schema/summary, named placeholders) and `backend/test/agent-guards.test.ts` (12 tests with a scripted mock model:
  plan rows, invalid plan, review round with hidden prompt not stored, unfinished plan → review → tool call → final,
  empty correction keeps draft, no review after a real write / `review:false`, repeat note, failure note at 3 + `stuck`
  at 6, wrap-up with `toolChoice none` and dropped calls, bounded concurrency with ordered results, overflow →
  compaction → retry, head+tail cap). All agent suites (`npx vitest run test/agent test/paper-reading.unit.test.ts
  --no-file-parallelism`): 105 passed.
- Live on staging (`glm/glm-5.3-flash`, student account): a meeting-prep request produced a 5-step plan, updated it
  0/5 → 2/5 → 5/5 across 8 steps with concurrent reads, hit three failed `get_deck_pages` calls in a row — the third got the
  「連續 3 次」 note and the model switched approach — and ended with a complete agenda; a request to falsely claim a note
  was refused by the model itself (the prompt rule), so the runtime review did not need to fire live (covered by tests).
  Screenshots of the checklist at 390 px (light) and 1280 px (dark), no horizontal scroll.

## 5. For the workflow engine (agent O)

Concrete, evidence-backed suggestions for `src/workflows/` (none of these files were touched by this work):

1. **Sub-agent briefs are the only context** — make it a rule of the dispatcher, not of the prompt: a sub-agent sees its
   instructions + dependency outputs + source excerpts and nothing of the chat ("it cannot see this conversation's
   history — everything it needs must be in the task brief", OpenHands `launch-child-conversation-client-tool.ts`;
   opencode `subagent.ts` "include all relevant context"). Depth 1 everywhere (codex `spawn.rs:75`, opencode, deepseek,
   Claude SDK): sub-agents never delegate.
2. **Schema-enforced step output** — each role returns JSON validated with zod; on failure return the validation errors and
   the expected shape once, then fail the attempt (goose `final_output_tool.rs`: "You MUST call the final_output tool
   NOW"; harness2 `STAGE_ATTEMPTS=2` with "# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n{err}"). Add a `status:
   complete|blocked` + `blocked_reason` field (deepseek Ralph handoff) so a sub-agent can say it is blocked instead of
   inventing content; blocked → orchestrator `awaiting_input`.
3. **Verifier output like codex review**: `issues[{severity, confidence 0–1, where, text}]` + `verdict` + overall
   confidence; only high/medium issues with confidence ≥ 0.6 trigger a fix round (prevents churn on vague nits); fix
   prompt = previous output + exact issues + "list what is fixed, then return the full corrected output" (OpenHands
   refinement follow-up). Parse JSON → first `{…}` → treat as failed verdict (codex `parse_review_output_event`).
4. **Reference-free judge rubric** for the final verification: ordered criteria DELIVERY (artifact exists, complete) →
   CONFORMANCE (to the approved plan/outline) → FIDELITY (every number/claim traceable to the source excerpts) →
   INTERNAL CONSISTENCY → FITNESS (usable as-is) → FINISH (no placeholders) (harness2 `prompts.py:1040–1102`). For
   competing drafts (e.g. two outlines) judge anonymised, shuffled candidates and require naming the runner-up.
5. **Completion audit, not absence of evidence**: a criterion passes only with positive evidence quoted from the artifact
   ("The audit must prove completion, not merely fail to find obvious remaining work", codex
   `templates/goals/continuation.md`); a check that cannot run is `skipped`, never `pass` (harness2: judge failure =
   `None`, excluded).
6. **Stuck detection per sub-agent** (OpenHands thresholds): same tool+args+result ×4 or same error ×3 → nudge once, then
   fail the step; consecutive tool failures 3 → note, 6 → fail (our `src/agent/guards.ts` `failureStreak`/`failureNote`
   are reusable as-is); identical fix-round output twice → stop fixing that step (no progress).
7. **Budgets**: one pooled run budget (tokens/calls/minutes) plus a per-step cap; inject a budget line into each sub-agent
   prompt from 50 % used ("become more direct", goose `ops_maxturns.rs`); on exhaustion run one tool-less wrap-up so the
   report says what is done/left (opencode max-steps, our `wrapUpNudge`). OpenHands gives children separate counters and
   writes cost back — prefer pooled so `usage` is honest.
8. **Parallelism**: run reads/researchers concurrently but keep writers that touch the same artifact serialized
   (codex RwLock: parallel-safe vs exclusive; codex worker role "disjoint write set"). Concurrency 3 is in line with
   cline teams (2) / goose (5).
9. **Partial results survive**: a sub-agent that hits a limit returns its partial output marked partial (OpenHands
   "Partial result:"), the step keeps it for the next fix round instead of starting from zero; resumable by step id.
10. **Context for long researcher runs**: reuse our compaction pieces — head+tail truncation (`truncateMiddle`), named
    placeholders for old reads, handoff summary template — and keep tool-call/result pairs together when cutting
    (OpenHands manipulation indices, cline `findCutIndex`).
11. **Plan card semantics**: approval only via the explicit button/route, never inferred from chat text (cline
    `switch_to_act_mode` "only after the user explicitly approved the plan in a message AFTER you presented it";
    deepseek "conversational agreement approves nothing").
12. **Eval harness for playbooks**: fixtures (a paper with known sections, a study with notes/tasks) + the deterministic
    checks + the judge rubric above, run offline on the cheapest model; report Partial (mean fraction of criteria) and
    All-pass (harness2 `report.py:108`); judge errors excluded, not zero. Use it before changing playbook prompts.
13. **Prompt cost discipline** for playbook/system prompts: "always-on prose is the expensive option; if you add a rule,
    cut one" (harness2 `prompts.py:129–146`); keep volatile facts (dates, ids) in the user/task message, not the system
    prompt (deepseek runtime context) so step prompts share a cache prefix.
