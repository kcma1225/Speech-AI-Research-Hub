import { describe, expect, it } from "vitest";
import { controlEvent, hostEvent } from "./remote.ts";

const V = "11111111-1111-4111-8111-111111111111";

describe("remote events from the server", () => {
  it("host: accepts the relay's commands only when well-formed", () => {
    expect(hostEvent(JSON.stringify({ type: "session", id: V }))).toEqual({ type: "session", id: V });
    expect(hostEvent(JSON.stringify({ type: "session", id: "../x" }))).toBeNull();
    expect(hostEvent('{"type":"remotes","count":2}')).toEqual({ type: "remotes", count: 2 });
    expect(hostEvent('{"type":"step","dir":-1}')).toEqual({ type: "step", dir: -1 });
    expect(hostEvent('{"type":"goto","page":0}')).toBeNull();
    expect(hostEvent('{"type":"laser","page":3,"x":0.1,"y":0.9,"down":false}')).toEqual({ type: "laser", page: 3, x: 0.1, y: 0.9, down: false });
    expect(hostEvent('{"type":"laser","page":3,"x":"0.1","y":0.9,"down":false}')).toBeNull();
    expect(hostEvent("{")).toBeNull();
    expect(hostEvent(new ArrayBuffer(4))).toBeNull();
  });

  it("control: the presented deck's state and the end", () => {
    expect(controlEvent(JSON.stringify({ type: "state", page: 2, total: 9, deckId: V, versionId: V, title: "週報", slug: "w" }))).toEqual({ type: "state", page: 2, total: 9, deckId: V, versionId: V, title: "週報", slug: "w" });
    expect(controlEvent(JSON.stringify({ type: "state", page: 2, total: 9, deckId: "x", versionId: V, title: "", slug: "" }))).toBeNull();
    expect(controlEvent('{"type":"ended"}')).toEqual({ type: "ended" });
  });
});
