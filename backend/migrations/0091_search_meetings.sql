-- Search: re-embed meetings when their text changes (tables from 0080_meetings). Owner types: `meeting` (title, notes,
-- AI drafts) and `transcript` (the meeting's shown transcript, `meetings.transcript_id`).

CREATE FUNCTION search_trg_meeting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM search_forget('meeting', OLD.id);
    IF OLD.transcript_id IS NOT NULL THEN PERFORM search_forget('transcript', OLD.transcript_id); END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' OR OLD.title IS DISTINCT FROM NEW.title OR OLD.notes IS DISTINCT FROM NEW.notes THEN
    PERFORM search_enqueue('meeting', NEW.id);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.transcript_id IS DISTINCT FROM NEW.transcript_id THEN
    IF OLD.transcript_id IS NOT NULL THEN PERFORM search_forget('transcript', OLD.transcript_id); END IF;
  END IF;
  IF NEW.transcript_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.transcript_id IS DISTINCT FROM NEW.transcript_id OR OLD.title IS DISTINCT FROM NEW.title) THEN
    PERFORM search_enqueue('transcript', NEW.transcript_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meetings_search_ins AFTER INSERT ON meetings FOR EACH ROW EXECUTE FUNCTION search_trg_meeting();
CREATE TRIGGER meetings_search_upd AFTER UPDATE OF title, notes, transcript_id ON meetings FOR EACH ROW EXECUTE FUNCTION search_trg_meeting();
CREATE TRIGGER meetings_search_del AFTER DELETE ON meetings FOR EACH ROW EXECUTE FUNCTION search_trg_meeting();

-- Transcript edited (segments) → re-embed it when it is the shown one; deleted → forget.
CREATE FUNCTION search_trg_transcript() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM search_forget('transcript', OLD.id); RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM meetings WHERE transcript_id = NEW.id) THEN PERFORM search_enqueue('transcript', NEW.id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transcripts_search_upd AFTER UPDATE OF segments ON transcripts FOR EACH ROW
  WHEN (OLD.segments IS DISTINCT FROM NEW.segments) EXECUTE FUNCTION search_trg_transcript();
CREATE TRIGGER transcripts_search_del AFTER DELETE ON transcripts FOR EACH ROW EXECUTE FUNCTION search_trg_transcript();

-- AI drafts (summary / feedback) are part of the meeting's text.
CREATE FUNCTION search_trg_meeting_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM search_enqueue('meeting', CASE WHEN TG_OP = 'DELETE' THEN OLD.meeting_id ELSE NEW.meeting_id END);
  RETURN NULL;
END $$;
CREATE TRIGGER meeting_drafts_search AFTER INSERT OR DELETE OR UPDATE OF summary_md, feedback_md, status ON meeting_study_drafts
  FOR EACH ROW EXECUTE FUNCTION search_trg_meeting_draft();
