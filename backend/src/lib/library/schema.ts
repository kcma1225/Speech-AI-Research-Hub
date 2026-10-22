import { z } from "zod";
import { PAPER_TYPES, type PaperRecord, type PaperType } from "./types.js";
import { finalizeRecord } from "./normalize.js";
import { CITE_KEY_RE } from "./citekey.js";

/** zod schemas for paper records coming from clients (manual add, edit, import confirm). */

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).optional().transform((v) => (v ? v : undefined));

export const authorSchema = z
  .object({
    family: optText(200),
    given: optText(200),
    literal: optText(300),
    particle: optText(60),
    suffix: optText(30),
  })
  .strip();

export const recordInputSchema = z
  .object({
    type: z.enum(PAPER_TYPES as [PaperType, ...PaperType[]]).default("article-journal"),
    title: text(1000).min(1),
    authors: z.array(authorSchema).max(500).default([]),
    editors: z.array(authorSchema).max(200).optional(),
    year: z.number().int().min(1000).max(3000).optional().nullable().transform((v) => v ?? undefined),
    month: z.number().int().min(1).max(12).optional().nullable().transform((v) => v ?? undefined),
    day: z.number().int().min(1).max(31).optional().nullable().transform((v) => v ?? undefined),
    containerTitle: optText(500),
    venue: optText(120),
    collectionTitle: optText(500),
    volume: optText(60),
    issue: optText(60),
    pages: optText(60),
    publisher: optText(300),
    publisherPlace: optText(200),
    edition: optText(60),
    isbn: optText(40),
    issn: optText(40),
    doi: optText(300),
    arxivId: optText(60),
    url: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((v) => (v ? v : undefined))
      .refine((v) => !v || /^https?:\/\//i.test(v), "url"),
    abstract: optText(20000),
    keywords: z.array(text(120)).max(100).optional(),
    language: optText(20),
    note: optText(4000),
    ids: z.record(z.string(), z.string().max(200)).optional(),
    oaPdfUrl: optText(2000),
    citeKey: z.string().trim().max(100).regex(CITE_KEY_RE).optional().or(z.literal("").transform(() => undefined)),
    bibtex: z.string().max(50000).optional(),
    extra: z.record(z.string(), z.string().max(4000)).optional(),
  })
  .strip();

/** Validates and normalizes a client-supplied record (throws ZodError → 400). */
export function parseRecordInput(input: unknown): PaperRecord {
  const r = recordInputSchema.parse(input) as PaperRecord;
  return finalizeRecord(r);
}

export const READING_STATUSES = ["unread", "reading", "read"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const tagsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(30)
  .transform((tags) => {
    const seen = new Set<string>();
    return tags.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  });

export const citeKeySchema = z.string().trim().min(1, "引用鍵不能是空的。").max(100, "引用鍵最多 100 個字元。").regex(CITE_KEY_RE, "引用鍵只能使用英數字與 _ : - .，不能有空白或中文。");
