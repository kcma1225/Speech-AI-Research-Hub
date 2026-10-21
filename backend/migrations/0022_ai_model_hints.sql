-- Per-model capability hints from vendor model listings (docs/architecture.md "AI platform → Vision").
-- Refreshed by the probe leader (at most every 6 h per bound account) and by the admin "test" button.
-- A route member's vision support = its `vision` param override, else these hints, else the registry entry.

CREATE TABLE ai_model_hints (
  provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model text NOT NULL,
  hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, model)
);

-- When an account's model list was last read (also set when the listing had no hints at all).
ALTER TABLE ai_providers ADD COLUMN model_hints_at timestamptz;
