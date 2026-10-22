import { beforeEach, describe, expect, it } from "vitest";
import {
  artifactFromUrl, artifactKey, artifactsOfCall, closeViewer, conversationArtifacts, findPageCites, normalizeRef, notifyArtifactChanged, openArtifact, paperBefore,
  refFromArtifact, refreshArtifact, viewer,
} from "./viewer.ts";
import type { ToolCall } from "./types.ts";
import { ViewerStore } from "./viewer-state.svelte.ts";

const O = "http://hub.test";
const N = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const F = "44444444-4444-4444-8444-444444444444";
const S = "55555555-5555-4555-8555-555555555555";
const M = "66666666-6666-4666-8666-666666666666";

const call = (over: Partial<ToolCall>): ToolCall => ({
  id: "c1", run_id: "r1", message_id: "m2", step: 0, position: 0, tool: "get_note", title: "", title_en: "", risk: "read", always_ask: false, grantable: false, open_world: false,
  status: "done", approved_via: null, approval_reason: null, decided_at: null, deny_reason: null, summary: "", target: null, args: {}, edited: false, result: null, error: null,
  provenance: [], created_at: "2026-10-21T01:00:00Z", finished_at: "2026-10-21T01:00:01Z", ...over,
});

describe("artifactFromUrl", () => {
  it("maps every hub document link", () => {
    expect(artifactFromUrl(`/studies/asr/notes/${N}`, O)?.ref).toMatchObject({ kind: "note", id: N });
    expect(artifactFromUrl(`/studies/asr/notes/${N}?suggestion=${S}`, O)?.focus).toEqual({ suggestionId: S });
    expect(artifactFromUrl(`/studies/asr/decks/${D}/edit?file=${F}&suggestion=${S}`, O)).toMatchObject({ ref: { kind: "deck", id: D }, focus: { fileId: F, suggestionId: S } });
    expect(artifactFromUrl(`/studies/asr/decks/${D}?p=3`, O)?.focus).toEqual({ page: 3 });
    expect(artifactFromUrl(`/slides/${D}`, O)?.ref.kind).toBe("deck");
    expect(artifactFromUrl(`/library?paper=${P}`, O)?.ref).toMatchObject({ kind: "paper", id: P });
    expect(artifactFromUrl(`/meetings/${M}?t=42`, O)).toMatchObject({ ref: { kind: "meeting", id: M }, focus: { time: 42 } });
    expect(artifactFromUrl(`/studies/asr%20x/latex/${P}?file=${F}`, O)).toMatchObject({ ref: { kind: "latex_project", id: P }, focus: { fileId: F } });
    expect(artifactFromUrl(`/api/agent/uploads/${F}`, O)?.ref.kind).toBe("upload");
    expect(artifactFromUrl(`${O}/studies/asr/notes/${N}`, O)?.ref.id).toBe(N);
  });

  it("ignores other pages, other origins and non-uuid ids", () => {
    expect(artifactFromUrl("/studies/asr?tab=papers", O)).toBeNull();
    expect(artifactFromUrl(`https://evil.example/studies/asr/notes/${N}`, O)).toBeNull();
    expect(artifactFromUrl("/studies/asr/notes/not-a-uuid", O)).toBeNull();
    expect(artifactFromUrl(`/meetings/${M}/extra`, O)).toBeNull();
    expect(artifactFromUrl("/settings?tab=assistant", O)).toBeNull();
  });
});

describe("refs", () => {
  it("opens a LaTeX file as its project focused on the file", () => {
    expect(normalizeRef({ kind: "latex_file", id: F, project_id: P })).toEqual({ ref: { kind: "latex_project", id: P }, focus: { fileId: F } });
    expect(artifactKey({ kind: "latex_file", id: F, project_id: P })).toBe(`latex_project:${P}`);
  });

  it("accepts workflow artifact payloads by kind/id or by url", () => {
    expect(refFromArtifact({ kind: "deck", id: D, url: `/studies/a/decks/${D}?p=2`, version: 3 })).toEqual({ ref: { kind: "deck", id: D, version: 3, url: `/studies/a/decks/${D}?p=2` }, focus: { page: 2 } });
    expect(refFromArtifact({ url: `/studies/a/notes/${N}` })?.ref.kind).toBe("note");
    expect(refFromArtifact({ kind: "nope", id: "x" })).toBeNull();
  });
});

describe("tool calls → artifacts", () => {
  it("reads ids from arguments, created objects and links", () => {
    expect(artifactsOfCall(call({ tool: "suggest_note_edit", risk: "write", args: { note_id: N }, result: { data: { suggestion_id: S }, links: [], source: null } }))).toEqual([{ ref: { kind: "note", id: N }, focus: { suggestionId: S }, title: undefined }]);
    const created = artifactsOfCall(call({ tool: "create_note", risk: "write", result: { data: { note: { id: N, title: "會議筆記" } }, links: [{ label: "會議筆記", url: `/studies/a/notes/${N}`, kind: "note" }], source: null } }));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ ref: { kind: "note", id: N }, title: "會議筆記" });
    const deck = artifactsOfCall(call({ tool: "suggest_deck_edit", risk: "write", args: { file_id: F }, target: { studyId: null, label: "x", url: `/studies/a/decks/${D}/edit?file=${F}` }, result: { data: { suggestion_id: S }, links: [], source: null } }));
    expect(deck[0]).toMatchObject({ ref: { kind: "deck", id: D }, focus: { fileId: F, suggestionId: S } });
    expect(artifactsOfCall(call({ tool: "view_paper_pages", args: { paper_id: P, pages: [5, 6] } }))[0]).toMatchObject({ ref: { kind: "paper", id: P }, focus: { page: 5 } });
  });

  it("lists the conversation's documents once, newest last, remembering writes", () => {
    const messages = [
      { id: "m1", seq: 1, created_at: "2026-10-21T00:00:00Z", attachments: [{ kind: "paper" as const, id: P, title: "Paper", study: null, url: `/library?paper=${P}` }] },
      { id: "m2", seq: 2, created_at: "2026-10-21T00:01:00Z", attachments: [] },
      { id: "m3", seq: 3, created_at: "2026-10-21T00:02:00Z", attachments: [] },
    ];
    const calls = [
      call({ id: "a", message_id: "m2", tool: "suggest_note_edit", risk: "write", args: { note_id: N } }),
      call({ id: "b", message_id: "m3", tool: "get_note", args: { note_id: N } }),
      call({ id: "c", message_id: "m3", tool: "get_deck", status: "failed", args: { deck_id: D } }),
    ];
    const list = conversationArtifacts(messages, calls);
    expect(list.map((x) => artifactKey(x.ref))).toEqual([`paper:${P}`, `note:${N}`]);
    expect(list[1]!.write).toBe(true);
    expect(list[0]!.title).toBe("Paper");
  });

  it("finds the paper an answer cites", () => {
    const messages = [
      { id: "u1", seq: 1, attachments: [] },
      { id: "a1", seq: 2, attachments: [] },
      { id: "a2", seq: 3, attachments: [] },
    ];
    const calls = [call({ message_id: "a1", tool: "read_paper", args: { paper_id: P } })];
    expect(paperBefore(messages, calls, "u1")).toBeNull();
    expect(paperBefore(messages, calls, "a2")).toBe(P);
  });
});

describe("page citations", () => {
  it("matches p. N, pp. N–M and 第 N 頁", () => {
    expect(findPageCites("見（§3.2，p. 4）與 p.12、pp. 5–7，第 9 頁").map((c) => c.page)).toEqual([4, 12, 5, 9]);
    expect(findPageCites("help. 3 apples, step.5")).toEqual([]);
  });
});

describe("viewer store", () => {
  beforeEach(() => {
    closeViewer();
    viewer.current = null;
    viewer.layout = "split";
    viewer.autoOpen = true;
    viewer.follow = true;
    viewer.unseen = 0;
  });

  it("opens, re-focuses and refreshes", () => {
    openArtifact({ kind: "paper", id: P }, { focus: { page: 5 } });
    expect(viewer.open).toBe(true);
    expect(viewer.current).toMatchObject({ key: `paper:${P}`, focus: { page: 5 } });
    const nonce = viewer.current!.nonce;
    openArtifact({ kind: "paper", id: P }, { focus: { page: 7 } });
    expect(viewer.current!.nonce).toBeGreaterThan(nonce);
    expect(viewer.recent[0]).toMatchObject({ kind: "paper", id: P });
    const before = viewer.revisionOf({ kind: "paper", id: P });
    refreshArtifact({ kind: "paper", id: P }, { focus: { page: 2 } });
    expect(viewer.revisionOf({ kind: "paper", id: P })).toBe(before + 1);
    expect(viewer.current!.focus).toEqual({ page: 2 });
    closeViewer();
    expect(viewer.open).toBe(false);
  });

  it("auto-opens AI changes unless turned off, and never switches the phone tab by itself", () => {
    notifyArtifactChanged({ kind: "note", id: N });
    expect(viewer.open).toBe(true);
    expect(viewer.current?.auto).toBe(true);
    closeViewer();
    viewer.current = null;
    viewer.autoOpen = false;
    notifyArtifactChanged({ kind: "note", id: N });
    expect(viewer.current).toBeNull();
    viewer.autoOpen = true;
    viewer.layout = "tabs";
    notifyArtifactChanged({ kind: "deck", id: D });
    expect(viewer.open).toBe(false);
    expect((viewer.current as { key: string } | null)?.key).toBe(`deck:${D}`);
    expect(viewer.unseen).toBe(1);
    viewer.showDocument();
    expect(viewer.open).toBe(true);
    expect(viewer.unseen).toBe(0);
  });

  it("does not move the view when 跟隨 AI is off", () => {
    openArtifact({ kind: "note", id: N }, { focus: { suggestionId: S } });
    viewer.follow = false;
    refreshArtifact({ kind: "note", id: N }, { focus: { line: 9 } });
    expect(viewer.current!.focus).toEqual({ suggestionId: S });
  });
});

describe("viewer state per conversation", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const fresh = () => {
    const v = new ViewerStore();
    v.layout = "split";
    return v;
  };

  it("restores each conversation's own documents and starts a new chat empty", () => {
    const v = fresh();
    v.bindConversation(A);
    v.openArtifact({ kind: "deck", id: D }, { focus: { page: 3 } });
    expect(v.current?.key).toBe(`deck:${D}`);
    // A new chat: nothing from A.
    v.bindConversation(null);
    expect(v.current).toBeNull();
    expect(v.open).toBe(false);
    expect(v.recent).toEqual([]);
    // Another conversation never shown here: empty too.
    v.bindConversation(B);
    expect(v.current).toBeNull();
    v.openArtifact({ kind: "note", id: N });
    v.closeViewer();
    // Back to A: its deck, open, same focus.
    v.bindConversation(A);
    expect(v.current).toMatchObject({ key: `deck:${D}`, focus: { page: 3 } });
    expect(v.open).toBe(true);
    expect(v.recent.map((r) => r.id)).toEqual([D]);
    // B kept its note (closed, as it was left).
    v.bindConversation(B);
    expect(v.current?.key).toBe(`note:${N}`);
    expect(v.open).toBe(false);
  });

  it("keeps what a new chat opened when that chat becomes a conversation", () => {
    const v = fresh();
    v.bindConversation(A);
    v.bindConversation(null);
    v.openArtifact({ kind: "paper", id: P });
    v.bindConversation(C, { adopt: true });
    expect(v.current?.key).toBe(`paper:${P}`);
    expect(v.open).toBe(true);
    // Choosing an existing conversation from a new chat does not carry the new chat's document over.
    v.bindConversation(null);
    v.openArtifact({ kind: "paper", id: P });
    v.bindConversation(B);
    expect(v.current).toBeNull();
  });

  it("restores closed on phones (the chat tab stays) and binding the same id is a no-op", () => {
    const v = fresh();
    v.bindConversation(A);
    v.openArtifact({ kind: "note", id: N });
    const nonce = v.current!.nonce;
    v.bindConversation(A);
    expect(v.current!.nonce).toBe(nonce);
    v.bindConversation(B);
    v.layout = "tabs";
    v.bindConversation(A);
    expect(v.current?.key).toBe(`note:${N}`);
    expect(v.open).toBe(false);
  });
});
