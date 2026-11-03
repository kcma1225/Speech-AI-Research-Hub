import { untrack } from "svelte";
import { askDeck } from "./ask.ts";
import { Listener } from "./listen.svelte.ts";

/**
 * State of 「提問助手」 on the phone remote, apart from its view (the controller shows it as a dock under the notes on
 * phones and as a side column on wide screens): the phone listens to the room (browser speech recognition), every
 * utterance is checked in automatic mode (is it a question for the presenter?) and answered from the deck and its
 * paper (lib/slides/ask.ts on the server); 「回答這題」 answers what was just said without the check; a typed question
 * too. Nothing is stored.
 */
export type AskCard = { id: number; heard: string; status: "answering" | "done" | "error"; text: string; error?: string; auto: boolean; at: Date; ctl: AbortController };

const read = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

export class AskSession {
  cards = $state<AskCard[]>([]);
  heard = $state<{ at: number; text: string }[]>([]);
  checking = $state(false);
  /** A note from automatic mode (rate limit reached). */
  autoNote = $state<string | null>(null);
  private _auto = $state(read("hub-ask-auto", "1") === "1");
  private _lang = $state(read("hub-ask-lang", "zh-TW"));
  readonly listener: Listener;

  private nextId = 1;
  private pending: string[] = [];
  private suppress = false;

  constructor(
    private readonly ctx: () => { deckId: string | null; page: number },
    private readonly onanswer?: (card: AskCard) => void,
  ) {
    this.listener = new Listener((text) => this.onUtterance(text), untrack(() => this._lang));
  }

  get auto() {
    return this._auto;
  }
  set auto(v: boolean) {
    this._auto = v;
    write("hub-ask-auto", v ? "1" : "0");
  }
  get lang() {
    return this._lang;
  }
  set lang(v: string) {
    this._lang = v;
    this.listener.lang = v;
    write("hub-ask-lang", v);
  }

  toggleListen() {
    if (this.listener.listening) this.listener.stop();
    else {
      this.autoNote = null;
      this.listener.lang = this._lang;
      this.listener.start();
    }
  }
  stop() {
    this.listener.stop();
    for (const c of this.cards) if (c.status === "answering") c.ctl.abort();
  }

  /** The room's recent words, oldest first (≤ 5000 chars), for the server's context. */
  private transcript = () => this.heard.map((h) => h.text).join("\n").slice(-5000);

  private onUtterance(text: string) {
    this.heard = [...this.heard, { at: Date.now(), text }].slice(-80);
    if (this.suppress || !this._auto || text.replace(/\s/g, "").length < 4) return;
    if (this.checking) this.pending.push(text);
    else void this.check(text);
  }

  // Automatic: one check at a time; utterances heard meanwhile are checked together next.
  private async check(text: string) {
    const { deckId, page } = this.ctx();
    if (!deckId) return;
    this.checking = true;
    const ctl = new AbortController();
    let card: AskCard | null = null;
    try {
      await askDeck(
        deckId,
        { heard: text, transcript: this.transcript(), page, gate: true },
        {
          signal: ctl.signal,
          onQuestion: () => {
            card = this.addCard(text, true, ctl);
          },
          onDelta: (d) => card && this.append(card.id, d),
        },
      );
      if (card) this.finish((card as AskCard).id);
    } catch (e) {
      if (card) this.fail((card as AskCard).id, (e as Error).message);
      else if ((e as { status?: number }).status === 429) this.autoNote = (e as Error).message;
    } finally {
      this.checking = false;
      const next = this.pending.splice(0).join(" ");
      if (next && this._auto && this.listener.listening) void this.check(next);
    }
  }

  private addCard(text: string, auto: boolean, ctl: AbortController): AskCard {
    const card: AskCard = { id: this.nextId++, heard: text, status: "answering", text: "", auto, at: new Date(), ctl };
    this.cards = [card, ...this.cards].slice(0, 30);
    try {
      navigator.vibrate?.([30, 40, 30]);
    } catch {}
    this.onanswer?.(card);
    return card;
  }
  private update = (id: number, f: (c: AskCard) => Partial<AskCard>) => (this.cards = this.cards.map((c) => (c.id === id ? { ...c, ...f(c) } : c)));
  private append = (id: number, d: string) => this.update(id, (c) => ({ text: c.text + d }));
  private finish = (id: number) => this.update(id, () => ({ status: "done" }));
  private fail = (id: number, error: string) => this.update(id, (c) => ({ status: c.text ? "done" : "error", error }));

  async answer(text: string) {
    const { deckId, page } = this.ctx();
    if (!deckId || !text.trim()) return;
    const ctl = new AbortController();
    const card = this.addCard(text.trim(), false, ctl);
    try {
      await askDeck(deckId, { heard: text.trim(), transcript: this.transcript(), page, gate: false }, { signal: ctl.signal, onDelta: (d) => this.append(card.id, d) });
      this.finish(card.id);
    } catch (e) {
      if ((e as Error).name === "AbortError") return this.finish(card.id);
      this.fail(card.id, (e as Error).message);
    }
  }

  /** Something to answer now: words being heard, or anything heard so far. */
  get canAnswerNow() {
    return !!this.heard.length || !!this.listener.interim;
  }
  /** 「回答這題」: what is being said now, else the last thing heard (with the one before when it was short). */
  answerNow() {
    this.suppress = true;
    const now = this.listener.flush();
    this.suppress = false;
    if (now) return void this.answer(now);
    const last = this.heard.at(-1);
    const prev = this.heard.at(-2);
    void this.answer(last && prev && last.text.length < 12 ? `${prev.text} ${last.text}` : (last?.text ?? ""));
  }
}
