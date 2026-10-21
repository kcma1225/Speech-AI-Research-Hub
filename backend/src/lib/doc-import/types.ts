/** What a format extractor returns before the common finalisation (cleanup, empty check, truncation). */
export type Extracted = { markdown: string; title: string | null; pages?: number; warnings: string[] };
