-- Notes, real-time collaboration (Yjs) and suggestions (docs/architecture.md "Notes", "Collaboration", "Suggestions").

-- Yjs document state, one row per collaborative document (`<namespace>:<id>`, e.g. `note:<uuid>`,
-- `latex:<projectId>:<fileId>`). `state` is Y.encodeStateAsUpdate of the whole document. Rule: once a row exists
-- it is the only source of the document; plain-text columns elsewhere are materialized copies and are NEVER used
-- to rebuild a document (reconnecting clients would merge their old copy and duplicate everything).
CREATE TABLE yjs_docs (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{0,31}:[A-Za-z0-9:_-]{1,200}$'),
  state bytea NOT NULL,
  size integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Note templates: `system` ones are maintained by admins (seeded below), `user` ones belong to `owner_id`.
CREATE TABLE note_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('system','user')),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  kind text NOT NULL DEFAULT 'custom' CHECK (kind IN ('research','experiment','reading','meeting','custom')),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  body_md text NOT NULL DEFAULT '' CHECK (length(body_md) <= 20000),
  -- Instruction for "AI 草擬" with this template (appended to the writing prompt).
  ai_prompt text NOT NULL DEFAULT '' CHECK (length(ai_prompt) <= 4000),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'system') = (owner_id IS NULL))
);
CREATE INDEX note_templates_owner ON note_templates (owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  template_id uuid REFERENCES note_templates(id) ON DELETE SET NULL,
  -- Template kind at creation (kept when the template is deleted; list icons and filters).
  kind text NOT NULL DEFAULT 'custom' CHECK (kind IN ('research','experiment','reading','meeting','custom')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  -- Materialized from the Yjs document `note:<id>` after every store (search, export, AI context). Never the source.
  content_md text NOT NULL DEFAULT '',
  event_date date,
  -- Latest note_versions.version (0 = none yet).
  version integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_study ON notes (study_id, updated_at DESC);
CREATE INDEX notes_title_trgm ON notes USING gin (title gin_trgm_ops);
CREATE INDEX notes_content_trgm ON notes USING gin (content_md gin_trgm_ops);

-- Snapshots: `auto` (after ≥ 10 min of editing), `manual` (儲存版本), `suggestion` (accepted suggestion),
-- `autopilot` (suggestion applied by the agent in autopilot), `restore` (restoring an older version), `initial`.
CREATE TABLE note_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('initial','auto','manual','suggestion','autopilot','restore')),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  content_md text NOT NULL,
  author text NOT NULL DEFAULT 'user' CHECK (author IN ('user','ai')),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, version)
);

-- Suggestions (AI or user) against a text target. `hunks`:
--   [{id, from, to, before, after, status: pending|accepted|rejected, start?, end?, decided_by?, decided_at?}]
-- `from`/`to` are offsets in the text the suggestion was computed against; for Yjs targets `start`/`end` are
-- base64 Y.RelativePosition anchors (start: first replaced char, assoc 0; end: last replaced char, assoc -1) so
-- hunks follow concurrent edits. A hunk is stale when the text between its anchors no longer equals `before`.
CREATE TABLE suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_]{1,31}$'),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 200),
  study_id uuid REFERENCES studies(id) ON DELETE CASCADE,
  doc_name text,
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user','ai','autopilot')),
  base_version integer,
  hunks jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','partial','rejected')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Agent conversation that produced it (no FK: the agent module owns that table).
  created_by_conversation uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX suggestions_target ON suggestions (target_type, target_id, created_at DESC);
CREATE INDEX suggestions_pending ON suggestions (study_id) WHERE status = 'pending';

INSERT INTO note_templates(scope, name, kind, description, position, body_md, ai_prompt) VALUES
('system', '研究筆記', 'research', '想法、觀察與進度的一般紀錄。', 0,
$$## 摘要

## 內容

## 想法與疑問

## 下一步
- [ ] $$,
'撰寫一篇研究筆記：整理目前的想法、觀察與進度，列出尚待釐清的問題與具體的下一步。'),
('system', '實驗筆記', 'experiment', '目的、設定、資料集、超參數、結果與分析。', 1,
$$## 目的

## 設定
- 程式碼版本：
- 硬體：

## 資料集
- 名稱：
- 切分（train / dev / test）：

## 超參數
| 參數 | 值 |
|---|---|
| learning rate | |
| batch size | |
| epochs | |

## 結果
| 設定 | 指標 | 數值 |
|---|---|---|
| | | |

## 分析

## 下一步
- [ ] $$,
'撰寫一篇實驗筆記：依「目的、設定、資料集、超參數、結果表格、分析、下一步」的結構填寫；不知道的數值保留空白或標示「待補」，不要捏造數字。'),
('system', '閱讀筆記', 'reading', '論文資訊、摘要、方法、優缺點與和我研究的關係。', 2,
$$## 論文資訊
- 標題：
- 作者：
- 出處 / 年份：
- 連結：

## 摘要

## 方法

## 優點

## 缺點與限制

## 與我研究的關係
$$,
'撰寫一篇論文閱讀筆記：依「論文資訊、摘要、方法、優缺點、與我研究的關係」的結構整理；與研究的關係要連結到研究簡述。'),
('system', '會議筆記', 'meeting', '會議摘要、老師回饋與待辦。', 3,
$$## 摘要

## 回饋

## 待辦
- [ ] $$,
'撰寫一篇會議筆記：依「摘要、回饋、待辦」整理；待辦用 Markdown 核取清單（- [ ] ）。');
