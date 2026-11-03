/**
 * The phone's ears for 「提問助手」: the browser's own speech recognition (Chrome / Android: Google; Safari / iOS: Apple),
 * so the server needs no ASR. Both engines behave differently in continuous mode (Android ends after a silence, iOS
 * rarely marks results final and may refuse a start that is not a tap), so one rule serves both: an utterance is the
 * text heard since the last one, committed after ~1.3 s without new words, while the same recognition keeps running.
 * Recognition that ends by itself restarts while listening; a restart the browser refuses asks for a tap. A stop
 * retires the recognition for good (its late events are ignored), a start waits for the stopped one to let go of the
 * microphone, and one that never opens the microphone is replaced and finally reported, never left looking alive.
 */
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
};
type RecCtor = new () => Rec;

const ctor = (): RecCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export type ListenError = "unsupported" | "not-allowed" | "service-not-allowed" | "audio-capture" | "network" | "stuck" | "other";

/** Silence that ends an utterance. */
const SILENCE_MS = 1300;
/** A recognition that has not opened the microphone by then is stuck. */
const STUCK_MS = 4000;

export class Listener {
  listening = $state(false);
  /** Asked to listen, the recognition has not started yet. */
  starting = $state(false);
  /** Words of the utterance being heard (not committed yet). */
  interim = $state("");
  error = $state<ListenError | null>(null);
  readonly supported = !!ctor();

  private rec: Rec | null = null;
  /** Bumped whenever a recognition is replaced: events of older ones are ignored. */
  private gen = 0;
  /** The recognition being stopped, until it ended. */
  private closing: { done: (() => void) | null } | null = null;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private recycles = 0;
  private want = false;
  private text = "";
  /** Characters of this recognition's transcript already committed. */
  private committed = 0;
  private full = "";
  /** A recognition of this listening session has started (a later refusal is not a missing permission). */
  private started = false;
  private silence: ReturnType<typeof setTimeout> | undefined;
  private restarts = 0;
  private lastStart = 0;

  constructor(
    private readonly onUtterance: (text: string) => void,
    public lang = "zh-TW",
  ) {}

  start() {
    const Ctor = ctor();
    if (!Ctor) {
      this.error = "unsupported";
      return;
    }
    this.error = null;
    this.want = true;
    this.restarts = 0;
    this.recycles = 0;
    this.started = false;
    this.starting = true;
    // The recognition just stopped may still hold the microphone (iOS then starts a new one that never hears):
    // wait for it to end, at most a moment.
    const old = this.closing;
    if (!old) return this.spawn(Ctor);
    const go = () => {
      clearTimeout(wait);
      old.done = null;
      if (this.want && !this.rec) this.spawn(Ctor);
    };
    const wait = setTimeout(go, 700);
    old.done = go;
  }

  stop() {
    this.want = false;
    this.commit();
    this.retire();
    this.listening = false;
    this.starting = false;
  }

  /** The current utterance now (「回答這題」 while the speaker is still finishing). */
  flush(): string {
    return this.commit();
  }

  /** Stops the running recognition; nothing it still reports counts. */
  private retire() {
    clearTimeout(this.silence);
    clearTimeout(this.watchdog);
    const rec = this.rec;
    this.rec = null;
    this.gen++;
    this.text = "";
    this.interim = "";
    if (!rec) return;
    const closing: { done: (() => void) | null } = { done: null };
    this.closing = closing;
    const ended = () => {
      if (this.closing === closing) this.closing = null;
      closing.done?.();
    };
    rec.onresult = null;
    rec.onerror = null;
    rec.onstart = null;
    rec.onaudiostart = null;
    rec.onend = ended;
    setTimeout(ended, 1500);
    try {
      rec.abort();
    } catch {
      ended();
    }
  }

  private spawn(Ctor: RecCtor) {
    const gen = ++this.gen;
    const rec = new Ctor();
    const mine = () => gen === this.gen && this.rec === rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let heard = false;
    rec.onstart = () => {
      if (!mine()) return;
      this.listening = true;
      this.starting = false;
      this.started = true;
      this.lastStart = Date.now();
    };
    rec.onaudiostart = () => {
      if (!mine()) return;
      heard = true;
      clearTimeout(this.watchdog);
    };
    this.committed = 0;
    this.full = "";
    this.text = "";
    rec.onresult = (e) => {
      if (!mine()) return;
      heard = true;
      clearTimeout(this.watchdog);
      let s = "";
      for (let i = 0; i < e.results.length; i++) s += e.results[i]![0]?.transcript ?? "";
      this.full = s;
      // An engine that revised already committed words: start over from what it has now.
      if (s.length < this.committed) this.committed = 0;
      this.text = s.slice(this.committed).trim();
      this.interim = this.text;
      clearTimeout(this.silence);
      this.silence = setTimeout(() => mine() && this.commit(), SILENCE_MS);
    };
    rec.onerror = (e) => {
      if (!mine()) return;
      // Silence / an abort we asked for are not errors.
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
        // Refused after it already ran (a restart without a tap, iOS): ask for a tap, not for a permission.
        this.error = this.started && e.error === "not-allowed" ? "other" : e.error;
        this.want = false;
      } else if (e.error === "network") this.error = "network";
      else this.error = "other";
    };
    rec.onend = () => {
      if (!mine()) return;
      clearTimeout(this.watchdog);
      this.commit();
      this.rec = null;
      if (!this.want) {
        this.listening = false;
        this.starting = false;
        return;
      }
      // Ended by itself (silence, time limit, a network blip): start again; back off when it keeps failing at once.
      const quick = Date.now() - this.lastStart < 1500;
      this.restarts = quick ? this.restarts + 1 : 0;
      if (this.restarts > 6) return this.giveUp();
      setTimeout(() => this.want && !this.rec && this.spawn(Ctor), quick ? 400 * this.restarts : 50);
    };
    // A recognition that never starts or never opens the microphone is stuck (seen on iOS after a stop and a quick
    // start): replace it, twice, then say so instead of looking as if it listened.
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (!mine() || heard) return;
      if (++this.recycles > 2) {
        this.retire();
        return this.giveUp();
      }
      this.retire();
      setTimeout(() => this.want && !this.rec && this.spawn(Ctor), 300);
    }, STUCK_MS);
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.error = "other";
      this.rec = null;
      this.giveUp();
    }
  }

  private giveUp() {
    this.want = false;
    this.listening = false;
    this.starting = false;
    this.error ??= "stuck";
  }

  /** Hands the heard text on (once) and clears it. */
  private commit(): string {
    clearTimeout(this.silence);
    const t = this.text.trim();
    this.committed = this.full.length;
    this.text = "";
    this.interim = "";
    if (t) this.onUtterance(t);
    return t;
  }
}
