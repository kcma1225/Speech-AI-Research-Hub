import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { aiFor, isPlatformError } from "../ai/platform/index.js";
import { isAiError } from "../ai/errors.js";
import type { LiveSession } from "../ai/asr/index.js";
import { currentUser } from "../lib/auth.js";
import { meetingGlossary } from "../lib/meetings/context.js";
import { findMeeting, meetingPermissions } from "../lib/meetings/store.js";

/**
 * Live captions while recording: `GET /api/meetings/:id/live?rate=16000` (WebSocket, role `asr_live`). The browser
 * sends PCM16 mono frames (binary) and `{type:"commit"}` / `{type:"stop"}` text messages; the server relays the
 * vendor's events as JSON: `ready {provider}` · `partial {itemId,text}` · `final {itemId,text,start?,end?,speaker?}` ·
 * `speech {state}` · `error {error, code, hint?}` · `closed`. Vendor keys never reach the browser. Captions are
 * ephemeral: the stored transcript comes from the recording (batch `asr`).
 * Auth like /api/collab: Origin must be APP_ORIGIN, valid session, and the caller must be able to edit the meeting.
 */

const MAX_SESSION_MS = 4 * 60 * 60_000;
const params = z.object({ id: z.uuid() });
const query = z.object({ rate: z.coerce.number().int().refine(v => v === 16000 || v === 24000 || v === 48000).default(16000) });

export default async function meetingLive(app: FastifyInstance) {
  const expectedOrigin = new URL(app.config.APP_ORIGIN).origin;

  const refuse = async (request: FastifyRequest): Promise<{ status: number; error: string } | null> => {
    if (request.headers.origin !== expectedOrigin) return { status: 403, error: "請從本站重新連線。" };
    const user = await currentUser(request);
    if (!user) return { status: 401, error: "請重新登入。" };
    const p = params.safeParse(request.params);
    const q = query.safeParse(request.query);
    if (!p.success || !q.success) return { status: 400, error: "欄位內容不正確。" };
    const meeting = await findMeeting(app.db, p.data.id);
    if (!meeting) return { status: 404, error: "會議不存在。" };
    if (!(await meetingPermissions(app.db, meeting, user)).edit) return { status: 403, error: "只有會議建立者、參與者或相關研究的成員可以錄音。" };
    return null;
  };

  app.get(
    "/meetings/:id/live",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const refused = await refuse(request);
        if (refused) return reply.code(refused.status).send({ error: refused.error });
      },
    },
    (socket: WebSocket, request) => {
      const { id } = params.parse(request.params);
      const { rate } = query.parse(request.query);
      const user = request.user!;
      const abort = new AbortController();
      const send = (payload: object) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
      };
      let session: LiveSession | null = null;
      let closed = false;
      const pending: Buffer[] = [];
      const timer = setTimeout(() => socket.close(1000, "time limit"), MAX_SESSION_MS);

      const shutdown = async () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        abort.abort();
        await session?.close().catch(() => {});
      };

      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          if (session) session.sendAudio(Buffer.from(data));
          else if (pending.length < 200) pending.push(Buffer.from(data));
          return;
        }
        let message: { type?: string } = {};
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }
        if (message.type === "commit") session?.commit();
        if (message.type === "stop") void shutdown().then(() => socket.close(1000, "stopped"));
      });
      socket.on("close", () => void shutdown());
      socket.on("error", () => void shutdown());

      void (async () => {
        try {
          const meeting = await findMeeting(app.db, id);
          const keyterms = await meetingGlossary(app.db, id).catch(() => []);
          const live = await aiFor(app).liveTranscribe(
            {
              sampleRate: rate,
              language: meeting?.language && meeting.language !== "auto" ? meeting.language : "zh-TW",
              keyterms,
              signal: abort.signal,
              onEvent: event => {
                if (event.type === "error") {
                  const e = event.error;
                  send({ type: "error", code: e.code, error: e.message_zh, hint: e.hint_zh });
                } else send(event);
              },
            },
            { userId: user.id, signal: abort.signal },
          );
          if (closed) {
            await live.close().catch(() => {});
            return;
          }
          session = live;
          for (const frame of pending.splice(0)) live.sendAudio(frame);
          send({ type: "ready", provider: live.route.providerKind });
        } catch (error) {
          const payload = isPlatformError(error)
            ? { type: "error", code: error.code, error: error.message_zh, hint: error.hint_zh }
            : isAiError(error)
              ? { type: "error", code: error.code, error: error.message_zh, hint: error.hint_zh }
              : { type: "error", code: "unavailable", error: "即時字幕暫時無法使用。" };
          if (!isPlatformError(error) && !isAiError(error)) app.log.warn({ err: error }, "live captions failed");
          send(payload);
          socket.close(1011, "unavailable");
        }
      })();
    },
  );
}
