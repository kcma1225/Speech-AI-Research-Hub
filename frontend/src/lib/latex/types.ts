/** API shapes of the LaTeX module (backend routes/latex*.ts; docs/architecture.md "LaTeX"). */

export type LatexKind = "paper" | "thesis" | "other";
export type LatexCompiler = "xelatex" | "pdflatex" | "lualatex";
export type FileRole = "main" | "section" | "bib" | "style" | "asset" | "other";

export type LatexTemplate = { id: string; name_zh: string; name_en: string; description_zh: string; description_en?: string; compiler: LatexCompiler; kind: LatexKind };

export type ProjectCard = {
  id: string;
  title: string;
  kind: LatexKind;
  template: string;
  compiler: LatexCompiler;
  bib_mode: "auto" | "manual";
  root_file: string;
  created_at: string;
  updated_at: string;
  updated_by_name: string | null;
  file_count: number;
  section_count: number;
  last_compile_id: string | null;
  last_compile_status: CompileStatus | null;
  last_compile_at: string | null;
  pdf_url: string | null;
  pdf_at: string | null;
};

export type LatexProject = {
  id: string;
  study_id: string;
  title: string;
  kind: LatexKind;
  template: string;
  root_file: string;
  compiler: LatexCompiler;
  bib_mode: "auto" | "manual";
  bib_file: string;
  settings: { bibFile?: string; sectionCommand?: "chapter" | "section"; haltOnError?: boolean };
  last_compile_id: string | null;
  last_pdf_compile_id: string | null;
  updated_at: string;
};

export type LatexFile = {
  id: string;
  path: string;
  kind: "text" | "binary";
  role: FileRole;
  position: number | null;
  bytes: number;
  content_type: string | null;
  updated_at: string;
  updated_by_name: string | null;
  /** First \chapter/\section heading of a .tex file. */
  title: string | null;
  /** The auto-generated bibliography (read-only in the editor). */
  generated: boolean;
};

export type Section = { file_id: string | null; path: string; title: string | null; position: number; disabled: boolean; managed: boolean; command: "input" | "include" };

export type CompileStatus = "queued" | "running" | "success" | "partial" | "failure" | "timeout" | "failed" | "cancelled";

export type Diagnostic = {
  severity: "error" | "warning" | "badbox" | "info";
  source: "latex" | "bibtex" | "biber" | "latexmk";
  file: string | null;
  line: number | null;
  message: string;
  context?: string;
  token?: string;
  generated?: boolean;
  code?: string;
  title_zh?: string;
  hint_zh?: string;
};

export type Compile = {
  id: string;
  status: CompileStatus;
  compiler: LatexCompiler;
  root_file: string;
  draft: boolean;
  stage: string | null;
  progress: number;
  error: string | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  warning_count: number;
  badbox_count: number;
  duration_ms: number | null;
  pdf_bytes: number | null;
  file_map: Record<string, string>;
  pdf_url: string | null;
  synctex_url: string | null;
  log_url: string | null;
  triggered_by: { id: string; name: string | null } | null;
  created_at: string;
  finished_at: string | null;
};

export type ProjectDetail = {
  project: LatexProject;
  study: { id: string; slug: string; title: string };
  files: LatexFile[];
  root_file_id: string | null;
  sections: Section[];
  permissions: { edit: boolean; manage: boolean; comment: boolean; role: string | null };
  latest_compile: Compile | null;
  pdf_compile: Compile | null;
  limits: { textBytes: number; binaryBytes: number; files: number };
};

export type LatexVersion = { id: string; kind: "manual" | "restore" | "backup" | "import"; label: string; file_count: number; bytes: number; created_at: string; created_by_name: string | null };

export type Symbols = {
  labels: { key: string; file_id: string; path: string; line: number }[];
  citations: { key: string; title: string | null; year: number | null; authors: string; source: string }[];
  files: { path: string; kind: "text" | "binary" }[];
};

export const isRunning = (s: CompileStatus | null | undefined) => s === "queued" || s === "running";
