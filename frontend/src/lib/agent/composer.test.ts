import { describe, expect, it } from "vitest";
import { answersFromText, composerMode, freeTextQuestion, pendingNames, queuedState, type ComposerInput } from "./composer.ts";
import type { AskQuestion } from "./types.ts";

const base: ComposerInput = { replying: false, pending: [], ask: null, workflow: null, chatOnly: false, queued: null };
const text: AskQuestion = { id: "topic", prompt: "簡報主題是什麼？", type: "short_text" };
const choice: AskQuestion = { id: "lang", prompt: "用哪個語言？", type: "single_choice", options: [{ value: "zh", label: "中文" }, { value: "en", label: "English" }] };
const choiceOther: AskQuestion = { ...choice, allow_other: true };
const multiOther: AskQuestion = { id: "m", prompt: "哪些？", type: "multi_choice", allow_other: true, options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }] };

describe("composerMode", () => {
  it("queues while a reply is streaming, whatever else waits", () => {
    expect(composerMode({ ...base, replying: true, pending: [{ id: "c", summary: "x" }] })).toEqual({ kind: "queue", appending: false });
    expect(composerMode({ ...base, replying: true, queued: { id: "q", text: "a", hold: null } })).toEqual({ kind: "queue", appending: true });
  });
  it("asks before cancelling consent cards", () => {
    const items = [{ id: "c1", summary: "刪除第 3 頁" }];
    expect(composerMode({ ...base, pending: items, ask: { callId: "a", questions: [text] } })).toEqual({ kind: "confirm_pending", items });
  });
  it("answers a one-question free-text card, confirms a choice-only one", () => {
    expect(composerMode({ ...base, ask: { callId: "a1", questions: [text] } })).toEqual({ kind: "answer_ask", callId: "a1", question: "簡報主題是什麼？" });
    expect(composerMode({ ...base, ask: { callId: "a1", questions: [choiceOther] } }).kind).toBe("answer_ask");
    expect(composerMode({ ...base, ask: { callId: "a1", questions: [choice] } })).toEqual({ kind: "confirm_ask", callId: "a1", question: "用哪個語言？" });
    // Several questions: the card is answered on the card.
    expect(composerMode({ ...base, ask: { callId: "a1", questions: [text, choice] } }).kind).toBe("confirm_ask");
  });
  it("routes to a waiting workflow unless the user switched to a normal chat", () => {
    const workflow = { id: "w1", title: "簡報", question: "要放在哪個研究？", cardOnly: false };
    expect(composerMode({ ...base, workflow })).toEqual({ kind: "answer_workflow", workflowId: "w1", title: "簡報", question: "要放在哪個研究？" });
    expect(composerMode({ ...base, workflow, chatOnly: true })).toEqual({ kind: "send" });
    expect(composerMode({ ...base, workflow: { ...workflow, cardOnly: true } }).kind).toBe("workflow_card");
    // An open assistant card comes first (it is the newest thing in the chat).
    expect(composerMode({ ...base, workflow, ask: { callId: "a", questions: [text] } }).kind).toBe("answer_ask");
  });
  it("sends normally otherwise", () => {
    expect(composerMode(base)).toEqual({ kind: "send" });
  });
});

describe("answersFromText (mirrors backend ask.ts)", () => {
  it("fills the free-text question and skips the others", () => {
    expect(answersFromText([text], "  語音情緒辨識 ")).toEqual([{ id: "topic", value: "語音情緒辨識" }]);
    expect(answersFromText([choiceOther, text], "其他寫法")).toEqual([{ id: "lang", value: null, other: "其他寫法" }, { id: "topic", skipped: true }]);
  });
  it("picks an option whose label is the text", () => {
    expect(answersFromText([choiceOther], "english")).toEqual([{ id: "lang", value: "en" }]);
    expect(answersFromText([multiOther], "乙")).toEqual([{ id: "m", value: ["b"] }]);
    expect(answersFromText([multiOther], "丙")).toEqual([{ id: "m", value: [], other: "丙" }]);
  });
  it("refuses choice-only cards, required other questions, empty text and (single) several questions", () => {
    expect(answersFromText([choice], "中文")).toBeNull();
    expect(answersFromText([text, { ...choice, required: true }], "x")).toBeNull();
    expect(answersFromText([text], "  ")).toBeNull();
    expect(freeTextQuestion([text, choice], { single: true })).toBeNull();
    expect(freeTextQuestion([text, choice])?.id).toBe("topic");
  });
});

describe("queuedState", () => {
  const queued = { id: "q", text: "x", hold: null } as const;
  it("follows the live state, the server's hold says why it waits", () => {
    expect(queuedState(base)).toBeNull();
    expect(queuedState({ ...base, queued, replying: true })).toBe("waiting");
    expect(queuedState({ ...base, queued, pending: [{ id: "c", summary: "s" }] })).toBe("held_approval");
    expect(queuedState({ ...base, queued: { ...queued, hold: "question" } })).toBe("held_question");
    expect(queuedState({ ...base, queued: { ...queued, hold: "error", error: "維護中" } })).toBe("held_error");
    expect(queuedState({ ...base, queued })).toBe("waiting");
  });
});

it("pendingNames quotes up to three actions", () => {
  expect(pendingNames([{ id: "1", summary: "刪除第 3 頁" }])).toBe("『刪除第 3 頁』");
  expect(pendingNames([1, 2, 3, 4].map((i) => ({ id: String(i), summary: `a${i}` })))).toBe("『a1』、『a2』、『a3』 等 4 項");
});
