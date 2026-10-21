-- Search (docs/architecture.md "Search"): incremental embedding index queue + triggers.
-- Keyword search reads the domain tables directly (ILIKE + the existing pg_trgm indexes); only semantic search needs an
-- index (`embeddings`, owned by the AI platform). Changes to searchable text enqueue the owner here, and one debounced
-- `ai_search_index` job (ai-worker) re-embeds changed chunks into every live space. Nothing is queued while no space is
-- live: binding the embedding role (or a model switch) runs `ai_embedding_reindex`, which walks every source anyway.

CREATE TABLE search_index_queue (
  owner_type text NOT NULL CHECK (owner_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  owner_id uuid NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_type, owner_id)
);
CREATE INDEX search_index_queue_time ON search_index_queue (enqueued_at);

-- Queue an owner and make sure one `ai_search_index` job is waiting (debounce: it runs 15 s later and only takes
-- entries that have been quiet for 10 s; see lib/search/index-job.ts).
CREATE FUNCTION search_enqueue(p_type text, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM embedding_spaces WHERE status IN ('active','building','ready')) THEN
    RETURN;
  END IF;
  INSERT INTO search_index_queue(owner_type, owner_id) VALUES (p_type, p_id)
    ON CONFLICT (owner_type, owner_id) DO UPDATE SET enqueued_at = now();
  IF NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'ai_search_index' AND status = 'queued') THEN
    INSERT INTO jobs(kind, payload, run_after, max_attempts) VALUES ('ai_search_index', '{}'::jsonb, now() + interval '15 seconds', 5);
    PERFORM pg_notify('jobs_new', 'ai_search_index');
  END IF;
END $$;

-- Content deleted: drop its vectors from every space right away (and any pending queue entry).
CREATE FUNCTION search_forget(p_type text, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM embeddings WHERE owner_type = p_type AND owner_id = p_id;
  DELETE FROM search_index_queue WHERE owner_type = p_type AND owner_id = p_id;
END $$;

-- Owner id of a study's paper link (study_papers has a composite key; embeddings.owner_id is a uuid).
CREATE FUNCTION search_study_paper_id(p_study uuid, p_paper uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(p_study::text || ':' || p_paper::text)::uuid
$$;

CREATE FUNCTION search_trg_note() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM search_forget('note', OLD.id); RETURN OLD; END IF;
  PERFORM search_enqueue('note', NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER notes_search_ins AFTER INSERT ON notes FOR EACH ROW EXECUTE FUNCTION search_trg_note();
CREATE TRIGGER notes_search_upd AFTER UPDATE OF title, content_md ON notes FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.content_md IS DISTINCT FROM NEW.content_md) EXECUTE FUNCTION search_trg_note();
CREATE TRIGGER notes_search_del AFTER DELETE ON notes FOR EACH ROW EXECUTE FUNCTION search_trg_note();

CREATE FUNCTION search_trg_study() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM search_forget('study', OLD.id); RETURN OLD; END IF;
  PERFORM search_enqueue('study', NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER studies_search_ins AFTER INSERT ON studies FOR EACH ROW EXECUTE FUNCTION search_trg_study();
CREATE TRIGGER studies_search_upd AFTER UPDATE OF title, summary_md ON studies FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.summary_md IS DISTINCT FROM NEW.summary_md) EXECUTE FUNCTION search_trg_study();
CREATE TRIGGER studies_search_del AFTER DELETE ON studies FOR EACH ROW EXECUTE FUNCTION search_trg_study();

CREATE FUNCTION search_trg_paper() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM search_forget('paper', OLD.id); RETURN OLD; END IF;
  PERFORM search_enqueue('paper', NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER papers_search_ins AFTER INSERT ON papers FOR EACH ROW EXECUTE FUNCTION search_trg_paper();
CREATE TRIGGER papers_search_upd AFTER UPDATE OF title, abstract, authors_text, venue ON papers FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.abstract IS DISTINCT FROM NEW.abstract
        OR OLD.authors_text IS DISTINCT FROM NEW.authors_text OR OLD.venue IS DISTINCT FROM NEW.venue)
  EXECUTE FUNCTION search_trg_paper();
CREATE TRIGGER papers_search_del AFTER DELETE ON papers FOR EACH ROW EXECUTE FUNCTION search_trg_paper();

-- A study's reading notes on a paper (owner type `study_paper`; only links with notes are embedded).
CREATE FUNCTION search_trg_study_paper() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM search_forget('study_paper', search_study_paper_id(OLD.study_id, OLD.paper_id)); RETURN OLD; END IF;
  PERFORM search_enqueue('study_paper', search_study_paper_id(NEW.study_id, NEW.paper_id));
  RETURN NEW;
END $$;
CREATE TRIGGER study_papers_search_ins AFTER INSERT ON study_papers FOR EACH ROW WHEN (NEW.notes_md <> '') EXECUTE FUNCTION search_trg_study_paper();
CREATE TRIGGER study_papers_search_upd AFTER UPDATE OF notes_md ON study_papers FOR EACH ROW
  WHEN (OLD.notes_md IS DISTINCT FROM NEW.notes_md) EXECUTE FUNCTION search_trg_study_paper();
CREATE TRIGGER study_papers_search_del AFTER DELETE ON study_papers FOR EACH ROW EXECUTE FUNCTION search_trg_study_paper();

-- No extra keyword indexes: keyword search scans a few thousand lab rows with ILIKE (ms); revisit if that grows.
