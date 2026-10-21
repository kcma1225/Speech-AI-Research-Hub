// Each feature keeps its strings in i18n/<feature>.ts: `zh` (zh-TW, `as const`) and `en` with the same keys.
// To add a module: import it and append it to BOTH lists below (one line each).
import * as core from "./i18n/core.ts";
import * as shared from "./i18n/shared.ts";
import * as manage from "./i18n/manage.ts";
import * as slides from "./i18n/slides.ts";
import * as studies from "./i18n/studies.ts";
import * as ai from "./i18n/ai.ts";
import * as library from "./i18n/library.ts";
import * as notes from "./i18n/notes.ts";
import * as search from "./i18n/search.ts";
import * as agent from "./i18n/agent.ts";
import * as meetings from "./i18n/meetings.ts";
import * as latex from "./i18n/latex.ts";
import * as vision from "./i18n/vision.ts";
import * as editor from "./i18n/editor.ts";
import * as attach from "./i18n/attach.ts";

const zh = {
  ...core.zh,
  ...shared.zh,
  ...manage.zh,
  ...slides.zh,
  ...studies.zh,
  ...ai.zh,
  ...library.zh,
  ...notes.zh,
  ...search.zh,
  ...agent.zh,
  ...meetings.zh,
  ...latex.zh,
  ...vision.zh,
  ...editor.zh,
  ...attach.zh,
};
export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  ...core.en,
  ...shared.en,
  ...manage.en,
  ...slides.en,
  ...studies.en,
  ...ai.en,
  ...library.en,
  ...notes.en,
  ...search.en,
  ...agent.en,
  ...meetings.en,
  ...latex.en,
  ...vision.en,
  ...editor.en,
  ...attach.en,
};

export const messages: Record<"zh-TW" | "en", Record<MessageKey, string>> = { "zh-TW": zh, en };
