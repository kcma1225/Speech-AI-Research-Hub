// Each feature keeps its strings in i18n/<feature>.ts (zh-TW first, then en with the same keys).
import * as core from "./i18n/core.ts";
import * as manage from "./i18n/manage.ts";
import * as notes from "./i18n/notes.ts";
import * as recordings from "./i18n/recordings.ts";
import * as slides from "./i18n/slides.ts";

const zh = { ...core.zh, ...slides.zh, ...notes.zh, ...recordings.zh, ...manage.zh };
export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = { ...core.en, ...slides.en, ...notes.en, ...recordings.en, ...manage.en };

export const messages: Record<"zh-TW" | "en", Record<MessageKey, string>> = { "zh-TW": zh, en };
