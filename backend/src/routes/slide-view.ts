import path from "node:path";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { secureCookies } from "../config.js";
import { notFound, parse } from "../lib/http.js";
import { projectBySlug, safeEqual, shareCookie, slideAccess, slideUrls, validCapability } from "../lib/slides/access.js";
import { slideDetail } from "../lib/slides/detail.js";
import { validPreviewToken } from "../lib/slides/preview.js";
import type { StoredObject } from "../lib/storage.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8", ".json": "application/json", ".map": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

// Opaque-origin sandbox throws on Web Storage access, which aborts Reveal init.
// Replace both stores with in-memory shims before any deck script runs. The annotate toolbar starts collapsed
// (player and presenter views; also for decks rendered before the plugin itself started collapsed). T or its fold
// button opens it.
const STORAGE_SHIM = "(function(){function m(){var d=Object.create(null);return{get length(){return Object.keys(d).length},key:function(i){return Object.keys(d)[i]??null},getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){Object.defineProperty(window,n,{value:m(),configurable:true});if(n==='localStorage')window.localStorage.setItem('annotate:prefs',JSON.stringify({collapsed:true}))}})})();";
const TOUCH_CSS = "<style>html:not(.print-pdf) .reveal .slide-number{bottom:auto;height:auto;padding:7px 9px;min-width:44px;min-height:44px;box-sizing:border-box;display:grid!important;place-items:center}html:not(.print-pdf) .reveal .slide-menu-button{min-width:44px;min-height:44px;display:grid;place-items:center}html:not(.print-pdf) .reveal .slide-menu-button a{display:grid;place-items:center;min-width:44px;min-height:44px}html:not(.print-pdf) .slide-menu-wrapper .slide-tool-item a{display:flex;align-items:center;min-height:44px}html.print-pdf .annotate-dock,html.print-pdf .slide-menu-button{display:none!important}</style>";

/**
 * Hub bridge (only when embedded): `s` / `f` without modifiers post `{namespace:"hub", type:"speaker"|"fullscreen"}`
 * to the parent instead of opening Reveal's notes popup / fullscreen. A capture listener on window runs before
 * Reveal's document listener and stops the event. Keys typed into form fields or contenteditable are left alone.
 */
const HUB_BRIDGE = "(function(){if(window.parent===window)return;window.addEventListener('keydown',function(e){if(e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||e.isComposing)return;var k=String(e.key||'').toLowerCase(),t=k==='s'?'speaker':k==='f'?'fullscreen':null;if(!t)return;var g=e.target;if(g&&(g.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(g.tagName||'')))return;e.preventDefault();e.stopImmediatePropagation();window.parent.postMessage({namespace:'hub',type:t},'*')},true)})();";

/**
 * Reveal sizes `.r-stretch` images (Quarto stretches a slide's lone image) when it lays the slide out; a lazily loaded
 * image that arrives later keeps height 0 until the next layout, so a deck opened at slide N showed no figure. Re-run
 * the layout when an image loads and right after a slide change.
 */
const RELAYOUT = "(function(){var t;function l(){clearTimeout(t);t=setTimeout(function(){try{if(window.Reveal&&Reveal.isReady&&Reveal.isReady())Reveal.layout()}catch(_){}},60)}document.addEventListener('load',function(e){if(e.target&&e.target.tagName==='IMG')l()},true);window.addEventListener('load',function(){try{Reveal.on('slidechanged',l);Reveal.on('ready',l)}catch(_){}})})();";

/**
 * Rewrites rendered deck HTML for the sandboxed, cookie-less iframe. Reveal gets `postMessage` (the parent can
 * call the Reveal API) and `postMessageEvents` (Reveal events are posted to the parent as JSON strings).
 */
export function patchDeckHtml(html: string) {
  return html
    .replace(/<head(\s[^>]*)?>/i, match => `${match}<script>${STORAGE_SHIM}${HUB_BRIDGE}${RELAYOUT}</script>`)
    .replace(/Reveal\.initialize\(\{/, "Reveal.initialize({scrollActivationWidth:0,postMessage:true,postMessageEvents:true,")
    .replace(/<\/head>/i, match => `${TOUCH_CSS}${match}`);
}

/** Sandbox CSP: the iframe has an opaque origin, so 'self' cannot load its own assets; name the app origin instead. */
export function deckCsp(origin: string) {
  return `sandbox allow-scripts allow-pointer-lock allow-presentation; default-src 'none'; script-src ${origin} https://cdn.jsdelivr.net 'unsafe-inline' 'unsafe-eval'; style-src ${origin} https://cdn.jsdelivr.net https://fonts.googleapis.com 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin} https://cdn.jsdelivr.net https://fonts.gstatic.com data:; media-src ${origin} blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${origin}`;
}

/** Validates a requested asset path relative to the output prefix; returns null when it must be refused. */
export function safeAssetPath(relative: string): string | null {
  if (!relative || relative.includes("\\") || relative.includes("\0") || relative.startsWith("/")) return null;
  if (relative.split("/").some(part => part === ".." || part === "." || part === "")) return null;
  const normalized = path.posix.normalize(relative);
  if (normalized.startsWith("/") || normalized.startsWith("../") || normalized === "..") return null;
  if (normalized === "slides.pdf" || normalized === "pdf.log" || normalized.startsWith("offline-assets/licenses/")) return null;
  // Hub-owned files (page images, manifest with notes) are served by the page routes only.
  if (normalized === "_hub" || normalized.startsWith("_hub/")) return null;
  return normalized;
}

const s3Status = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

/** Sends an S3 object, forwarding Range responses. */
function sendObject(reply: FastifyReply, object: StoredObject, contentType: string) {
  reply.header("Content-Type", contentType).header("Accept-Ranges", "bytes");
  if (object.contentLength !== undefined) reply.header("Content-Length", object.contentLength);
  if (object.contentRange) reply.code(206).header("Content-Range", object.contentRange);
  return reply.send(object.body);
}

const viewParams = z.object({ slug: z.string().min(1).max(80), token: z.string().min(1).max(200), versionId: z.uuid(), "*": z.string().max(1024).optional() });
const previewParams = z.object({ slug: z.string().min(1).max(80), token: z.string().min(1).max(200), previewId: z.uuid(), "*": z.string().max(1024).optional() });
const slugParams = z.object({ slug: z.string().min(1).max(80) });
const pdfParams = z.object({ slug: z.string().min(1).max(80), versionId: z.uuid() });
const referenceParams = z.object({ slug: z.string().min(1).max(80), referenceId: z.uuid() });
const shareParams = z.object({ slug: z.string().min(1).max(80), key: z.string().min(1).max(200) });
const keyQuery = z.object({ key: z.string().max(200).optional() });

const slideView: FastifyPluginAsync = async app => {
  const secret = app.config.AUTH_SECRET;
  const origin = new URL(app.config.APP_ORIGIN).origin;
  const csp = deckCsp(origin);

  /** Player data for signed-in users, public decks, and share-key holders. */
  app.get("/slides/by-slug/:slug", async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const { key } = parse(keyQuery, request.query);
    const access = await slideAccess(request, slug, key);
    if (!access) throw notFound("簡報不存在。");
    const context = { mode: "slug" as const, ...(access.viaKey ? { key } : {}) };
    return reply.header("Cache-Control", "private, no-store").send(await slideDetail(app.db, secret, access.project, access.user, context));
  });

  /** Capability URL: remembers the share key in a cookie, then opens the player. */
  app.get("/slides/share/:slug/:key", async (request, reply) => {
    const { slug, key } = parse(shareParams, request.params);
    const project = await projectBySlug(app.db, slug);
    if (!project || !safeEqual(key, project.share_key)) throw notFound("找不到分享連結。");
    reply.setCookie(shareCookie(slug), key, { httpOnly: true, sameSite: "lax", secure: secureCookies(app.config), path: "/", maxAge: 30 * 86_400 });
    return reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer").redirect(slideUrls.player(slug), 302);
  });

  const serveAsset = async (request: FastifyRequest, reply: FastifyReply) => {
    const deny = () => reply.code(404).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Not found");
    const params = viewParams.safeParse(request.params);
    if (!params.success) return deny();
    const { slug, token, versionId } = params.data;
    const project = await projectBySlug(app.db, slug);
    // Opaque-origin sandbox sends no cookies: authorise by path capability only.
    if (!project || !validCapability(secret, token, project, versionId)) return deny();
    const version = (await app.db.query<{ entry_html: string; output_prefix: string; shared_prefix: string | null }>(
      "SELECT entry_html,output_prefix,shared_prefix FROM slide_versions WHERE deck_id=$1 AND id=$2 AND status='published' AND entry_html IS NOT NULL",
      [project.id, versionId],
    )).rows[0];
    if (!version) return deny();
    return sendAsset(request, reply, params.data["*"] || version.entry_html, relative => assetKey(version, relative));
  };

  /** Quick preview of an in-app source tree: `p.<exp>.<hmac>` token only (never public or the share key). */
  const servePreview = async (request: FastifyRequest, reply: FastifyReply) => {
    const deny = () => reply.code(404).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Not found");
    const params = previewParams.safeParse(request.params);
    if (!params.success) return deny();
    const { slug, token, previewId } = params.data;
    const project = await projectBySlug(app.db, slug);
    if (!project || !validPreviewToken(secret, token, project.id, previewId)) return deny();
    const preview = (await app.db.query<{ entry_html: string; output_prefix: string }>(
      "SELECT entry_html,output_prefix FROM deck_previews WHERE id=$1 AND deck_id=$2 AND status='ready' AND entry_html IS NOT NULL",
      [previewId, project.id],
    )).rows[0];
    if (!preview) return deny();
    return sendAsset(request, reply, params.data["*"] || preview.entry_html, relative => preview.output_prefix + relative);
  };

  /** Streams one deck asset with the sandbox headers; HTML is patched for the cookie-less iframe. */
  const sendAsset = async (request: FastifyRequest, reply: FastifyReply, requested: string, keyFor: (relative: string) => string) => {
    const deny = () => reply.code(404).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Not found");
    const relative = safeAssetPath(requested);
    if (!relative) return reply.code(400).type("text/plain; charset=utf-8").send("Invalid path");

    const extension = path.posix.extname(relative).toLowerCase();
    const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
    const isHtml = extension === ".html" || extension === ".htm";
    let object: StoredObject | null;
    try {
      object = await app.storage.get(keyFor(relative), isHtml ? undefined : request.headers.range);
    } catch (error) {
      if (s3Status(error) === 416) return reply.code(416).send();
      throw error;
    }
    if (!object) return deny();
    reply
      .header("Content-Security-Policy", csp)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Vary", "Origin");
    // The sandboxed iframe has an opaque origin, so CORS-mode loads (web fonts, module scripts) arrive with
    // `Origin: null`. The path capability already authorises the request; let that opaque origin read it.
    if (request.headers.origin === "null") reply.header("Access-Control-Allow-Origin", "null");
    if (isHtml) {
      const chunks: Buffer[] = [];
      for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
      return reply.header("Content-Type", "text/html; charset=utf-8").send(patchDeckHtml(Buffer.concat(chunks).toString("utf8")));
    }
    return sendObject(reply, object, contentType);
  };
  app.get("/slides/view/:slug/:token/:versionId", serveAsset);
  app.get("/slides/view/:slug/:token/:versionId/*", serveAsset);
  app.get("/slides/view/:slug/:token/preview/:previewId", servePreview);
  app.get("/slides/view/:slug/:token/preview/:previewId/*", servePreview);

  app.get("/slides/pdf/:slug/:versionId", async (request, reply) => {
    const { slug, versionId } = parse(pdfParams, request.params);
    const { key } = parse(keyQuery, request.query);
    const access = await slideAccess(request, slug, key);
    if (!access) throw notFound("簡報不存在。");
    const version = (await app.db.query<{ version: number; pdf_key: string | null }>(
      "SELECT version,pdf_key FROM slide_versions WHERE id=$1 AND deck_id=$2 AND status='published'",
      [versionId, access.project.id],
    )).rows[0];
    const object = version?.pdf_key ? await app.storage.get(version.pdf_key, request.headers.range) : null;
    if (!version || !object) throw notFound("PDF 尚未產生。");
    reply
      .header("Content-Disposition", `attachment; filename="${slug}-v${version.version}.pdf"`)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff");
    return sendObject(reply, object, "application/pdf");
  });

  app.get("/slides/reference/:slug/:referenceId", async (request, reply) => {
    const { slug, referenceId } = parse(referenceParams, request.params);
    const { key } = parse(keyQuery, request.query);
    const access = await slideAccess(request, slug, key);
    if (!access) throw notFound("參考資料不存在。");
    const reference = (await app.db.query<{ url: string | null; file_key: string | null; file_name: string | null }>(
      "SELECT url,file_key,file_name FROM slide_references WHERE id=$1 AND deck_id=$2",
      [referenceId, access.project.id],
    )).rows[0];
    if (!reference) throw notFound("參考資料不存在。");
    if (reference.url) return reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer").redirect(reference.url, 302);
    const object = reference.file_key ? await app.storage.get(reference.file_key, request.headers.range) : null;
    if (!object) throw notFound("參考資料不存在。");
    const name = reference.file_name || "reference.pdf";
    reply
      .header("Content-Disposition", `inline; filename="reference.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff");
    return sendObject(reply, object, "application/pdf");
  });
};

export default slideView;

const SHARED_DIR = "offline-assets/";
/** offline-assets/ of newer renders lives in a prefix shared across versions (see worker slide-render). */
export function assetKey(version: { output_prefix: string; shared_prefix: string | null }, relative: string) {
  if (version.shared_prefix && relative.startsWith(SHARED_DIR)) return version.shared_prefix + relative.slice(SHARED_DIR.length);
  return version.output_prefix + relative;
}
