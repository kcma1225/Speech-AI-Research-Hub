-- AI platform v2 routing (docs/architecture.md "AI platform"): per-model profiles + ONE routing configuration
-- (groups that nest, role bindings to a model or a group). Replaces named routes (ai_routes / ai_route_members /
-- ai_role_routes) and the vision-only ai_model_hints. Existing data is converted:
--   * every model a route used (and every listed hint row) becomes an ai_models profile;
--   * a route with exactly one model member is "single-model": a role bound to it is bound to that model directly
--     (with the member's params), a parent that nested it gets the model inline; otherwise the route becomes a group
--     with the same id (strategy `single` becomes `fallback`);
--   * route-member `vision` params become the model profile's manual `vision`; `max_tokens` params are dropped
--     (output limits come from the model profile now);
--   * Ollama `numCtx` and Anthropic `defaultMaxTokens` leave the provider config (num_ctx becomes the models'
--     manual context window);
--   * embedding spaces point at their model profile (+ group when served by one); the call log keeps working
--     (route_id → group_id, plus model_ref).

-- ---------------------------------------------------------------- model profiles

-- One row per (account, model id). The effective profile is computed in code with the precedence
-- manual (`overrides`) > provider listing (`api`) > built-in catalog (backend/src/ai/catalog), field by field.
-- Fields: display_name, capability (chat|embedding|asr), context_window, max_output_tokens, vision, tools, reasoning,
-- json_schema, embedding_dims, input_price / output_price (USD per 1M tokens).
CREATE TABLE ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 300),
  -- `sync`: came from the account's model listing (removed again when it disappears and nothing uses it);
  -- `manual`: added by an admin or by a binding/group that named it.
  origin text NOT NULL DEFAULT 'sync' CHECK (origin IN ('sync','manual')),
  -- Present in the latest listing.
  listed boolean NOT NULL DEFAULT false,
  -- Shown in pickers. Existing bindings keep working when a model is hidden.
  enabled boolean NOT NULL DEFAULT true,
  api jsonb NOT NULL DEFAULT '{}'::jsonb,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id)
);

INSERT INTO ai_models(provider_id, model_id, origin, listed, api, refreshed_at)
SELECT h.provider_id, h.model, 'sync', true,
       jsonb_strip_nulls(jsonb_build_object('vision', h.hints->'vision', 'tools', h.hints->'tools', 'reasoning', h.hints->'reasoning', 'json_schema', h.hints->'jsonSchema')),
       h.updated_at
  FROM ai_model_hints h
ON CONFLICT (provider_id, model_id) DO NOTHING;

INSERT INTO ai_models(provider_id, model_id, origin, listed)
SELECT DISTINCT m.provider_id, m.model, 'manual', false
  FROM ai_route_members m
 WHERE m.provider_id IS NOT NULL AND m.model IS NOT NULL
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- Models placed in embedding routes are embedding models (the admin said so).
UPDATE ai_models am SET overrides = am.overrides || '{"capability":"embedding"}'::jsonb
  FROM ai_route_members m JOIN ai_routes r ON r.id = m.route_id
 WHERE r.capability = 'embedding' AND m.provider_id = am.provider_id AND m.model = am.model_id;

-- Vision overrides move from route members to the model profile.
UPDATE ai_models am SET overrides = am.overrides || jsonb_build_object('vision', (m.params->>'vision') = 'yes')
  FROM ai_route_members m
 WHERE m.params->>'vision' IN ('yes','no') AND m.provider_id = am.provider_id AND m.model = am.model_id;

-- Ollama's context length becomes the models' manual context window.
UPDATE ai_models am SET overrides = am.overrides || jsonb_build_object('context_window', (p.config->>'numCtx')::numeric::integer)
  FROM ai_providers p
 WHERE p.id = am.provider_id AND p.kind = 'ollama' AND (p.config->>'numCtx') ~ '^[0-9]+(\.0+)?$' AND NOT (am.overrides ? 'context_window');
UPDATE ai_providers SET config = config - 'numCtx' - 'defaultMaxTokens' WHERE config ?| ARRAY['numCtx','defaultMaxTokens'];

ALTER TABLE ai_providers RENAME COLUMN model_hints_at TO models_synced_at;

-- ---------------------------------------------------------------- groups

-- A group is a strategy over members; members are model profiles or child groups (nesting; cycles and depth > 6
-- are rejected by the API). `capability` decides which models fit and which roles may bind it.
CREATE TABLE ai_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  capability text NOT NULL CHECK (capability IN ('chat','embedding','asr')),
  strategy text NOT NULL CHECK (strategy IN ('fallback','load_balance','round_robin')),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- `params`: request-shaping settings only (timeout, retries, temperature, top_p, reasoning effort, vendor
-- passthrough, ASR options), validated against the registry whitelist. Limits come from the model profile.
CREATE TABLE ai_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES ai_groups(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  model_ref uuid REFERENCES ai_models(id) ON DELETE RESTRICT,
  child_group_id uuid REFERENCES ai_groups(id) ON DELETE RESTRICT,
  weight integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 1000),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  CHECK ((model_ref IS NULL) <> (child_group_id IS NULL)),
  CHECK (child_group_id IS NULL OR child_group_id <> group_id),
  UNIQUE (group_id, position)
);
CREATE INDEX ai_group_members_model ON ai_group_members(model_ref) WHERE model_ref IS NOT NULL;
CREATE INDEX ai_group_members_child ON ai_group_members(child_group_id) WHERE child_group_id IS NOT NULL;

-- Role bindings (功能綁定): role → one model or one group. Code asks for a role, never a model.
CREATE TABLE ai_role_bindings (
  role text PRIMARY KEY CHECK (role IN ('assistant','writing','slides','analysis','fast','embedding','asr','asr_live')),
  model_ref uuid REFERENCES ai_models(id) ON DELETE RESTRICT,
  group_id uuid REFERENCES ai_groups(id) ON DELETE RESTRICT,
  -- Request-shaping params for a direct model binding (same whitelist as group members).
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((model_ref IS NULL) <> (group_id IS NULL))
);

-- ---------------------------------------------------------------- convert routes

CREATE TEMP TABLE _single_route ON COMMIT DROP AS
SELECT r.id AS route_id, (array_agg(m.id))[1] AS member_id
  FROM ai_routes r JOIN ai_route_members m ON m.route_id = r.id
 GROUP BY r.id
HAVING count(*) = 1 AND bool_and(m.provider_id IS NOT NULL);

INSERT INTO ai_groups(id, name, capability, strategy, description, created_at, updated_at)
SELECT r.id, r.name, r.capability, CASE WHEN r.strategy = 'single' THEN 'fallback' ELSE r.strategy END, r.description, r.created_at, r.updated_at
  FROM ai_routes r
 WHERE r.id NOT IN (SELECT route_id FROM _single_route);

INSERT INTO ai_group_members(id, group_id, position, model_ref, child_group_id, weight, params, enabled)
SELECT m.id, m.route_id, m.position,
       CASE WHEN m.provider_id IS NOT NULL THEN am.id ELSE cam.id END,
       CASE WHEN m.child_route_id IS NOT NULL AND s.route_id IS NULL THEN m.child_route_id END,
       m.weight,
       (CASE WHEN m.provider_id IS NOT NULL THEN m.params ELSE coalesce(cm.params, m.params) END) - 'vision' - 'max_tokens',
       m.enabled AND coalesce(cm.enabled, true)
  FROM ai_route_members m
  JOIN ai_groups g ON g.id = m.route_id
  LEFT JOIN ai_models am ON am.provider_id = m.provider_id AND am.model_id = m.model
  LEFT JOIN _single_route s ON s.route_id = m.child_route_id
  LEFT JOIN ai_route_members cm ON cm.id = s.member_id
  LEFT JOIN ai_models cam ON cam.provider_id = cm.provider_id AND cam.model_id = cm.model;

INSERT INTO ai_role_bindings(role, model_ref, group_id, params, updated_by, updated_at)
SELECT b.role, cam.id, CASE WHEN s.route_id IS NULL THEN b.route_id END,
       coalesce(cm.params, '{}'::jsonb) - 'vision' - 'max_tokens', b.updated_by, b.updated_at
  FROM ai_role_routes b
  LEFT JOIN _single_route s ON s.route_id = b.route_id
  LEFT JOIN ai_route_members cm ON cm.id = s.member_id
  LEFT JOIN ai_models cam ON cam.provider_id = cm.provider_id AND cam.model_id = cm.model;

-- ---------------------------------------------------------------- embedding spaces

-- A space is keyed by its embedding model profile; `group_id` is set when a group of deployments of that same
-- model serves it (fallback between identical fingerprints). Serving target = group when set, else the model.
-- `params`: request params of a direct model target (e.g. `dimensions`), copied when the space is created.
ALTER TABLE embedding_spaces
  ADD COLUMN model_ref uuid REFERENCES ai_models(id) ON DELETE SET NULL,
  ADD COLUMN group_id uuid REFERENCES ai_groups(id) ON DELETE SET NULL,
  ADD COLUMN params jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE embedding_spaces e SET params = cm.params - 'vision' - 'max_tokens'
  FROM _single_route s JOIN ai_route_members cm ON cm.id = s.member_id WHERE s.route_id = e.route_id;
UPDATE embedding_spaces e SET group_id = e.route_id WHERE e.route_id IN (SELECT id FROM ai_groups);
UPDATE embedding_spaces e SET model_ref = am.id
  FROM ai_providers p JOIN ai_models am ON am.provider_id = p.id
 WHERE p.kind = e.provider_kind AND am.model_id = e.model
   AND (e.group_id IS NULL OR am.id IN (SELECT model_ref FROM ai_group_members WHERE group_id = e.group_id))
   AND (e.group_id IS NOT NULL OR am.id IN (
         SELECT cam.id FROM _single_route s JOIN ai_route_members cm ON cm.id = s.member_id
           JOIN ai_models cam ON cam.provider_id = cm.provider_id AND cam.model_id = cm.model WHERE s.route_id = e.route_id));
ALTER TABLE embedding_spaces DROP COLUMN route_id;

-- ---------------------------------------------------------------- call log

ALTER TABLE ai_call_log RENAME COLUMN route_id TO group_id;
ALTER TABLE ai_call_log ADD COLUMN model_ref uuid;
UPDATE ai_call_log l SET model_ref = am.id FROM ai_models am WHERE am.provider_id = l.provider_id AND am.model_id = l.model;
UPDATE ai_call_log SET group_id = NULL WHERE group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM ai_groups);
CREATE INDEX ai_call_log_model_ref ON ai_call_log(model_ref, started_at DESC) WHERE model_ref IS NOT NULL;

-- ---------------------------------------------------------------- drop the old shape

DROP TABLE ai_role_routes;
DROP TABLE ai_route_members;
DROP TABLE ai_routes;
DROP TABLE ai_model_hints;
