/** Forgiving ask_user input and the JSON schema the model sees. */
import { describe, expect, it } from "vitest";
import { askUserInput } from "../src/agent/ask.js";
import { getAgentTool, toolJsonSchema } from "../src/agent/tools/index.js";

describe("ask_user input", () => {
  it("fills missing option values from labels and the prompt from an alias", () => {
    const r = askUserInput.parse({
      questions: [{ id: "which", question: "要改哪一個？", type: "single_choice", options: [{ label: "較新的" }, { label: "較舊的", description: "x" }, "兩份都改"] }],
    });
    expect(r.questions[0]!.prompt).toBe("要改哪一個？");
    expect(r.questions[0]!.options!.map((o) => o.value)).toEqual(["較新的", "較舊的", "兩份都改"]);
  });
  it("keeps given values, de-duplicates derived ones, still rejects real problems", () => {
    const r = askUserInput.parse({ questions: [{ id: "q", prompt: "p", type: "multi_choice", options: [{ value: "a", label: "A" }, { label: "a" }, { label: "x".repeat(100) }] }] });
    expect(r.questions[0]!.options!.map((o) => o.value)).toEqual(["a", "o2", "o3"]);
    expect(askUserInput.safeParse({ questions: [{ id: "q", type: "short_text" }] }).success).toBe(false);
    expect(askUserInput.safeParse({ questions: [{ id: "q", prompt: "p", type: "single_choice" }] }).success).toBe(false);
  });
  it("the model still sees the full question schema", () => {
    const schema = toolJsonSchema(getAgentTool("ask_user")!) as { properties: { questions: { items: { properties: Record<string, unknown>; required: string[] } } } };
    expect(Object.keys(schema.properties.questions.items.properties)).toEqual(expect.arrayContaining(["id", "prompt", "type", "options"]));
    expect(schema.properties.questions.items.required).toEqual(expect.arrayContaining(["id", "prompt", "type"]));
  });
});
