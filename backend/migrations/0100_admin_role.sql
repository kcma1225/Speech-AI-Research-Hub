-- Administration becomes an account kind: role 'admin' (system settings, users, invitations only; no research
-- workspace). `is_admin` stays as a denormalised flag that always equals (role = 'admin'). `is_owner` now marks the
-- initial admin (bootstrap account, 初始管理員): always an enabled admin, cannot be demoted or disabled.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_check;
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_check;

-- The bootstrap account becomes the initial admin; a staging "Owner" is renamed to the new default name.
UPDATE users SET role = 'admin', is_admin = true WHERE is_owner;
UPDATE users SET name = 'admin'
 WHERE is_owner AND name = 'Owner' AND NOT EXISTS (SELECT 1 FROM users o WHERE lower(o.name) = 'admin' AND NOT o.is_owner);
-- Students and professors can no longer be administrators.
UPDATE users SET is_admin = false WHERE role <> 'admin';
UPDATE invitations SET is_admin = (role = 'admin');

-- Admin accounts take no part in studies. For a study owned by an admin, its earliest non-admin member becomes the
-- owner (the admin's row is removed first: one owner per study). Studies without such a member keep the admin owner
-- row (nobody else could manage them); the workspace guard keeps the admin out anyway.
CREATE TEMP TABLE _admin_heirs ON COMMIT DROP AS
  SELECT DISTINCT ON (m.study_id) m.study_id, m.user_id
    FROM study_members m
    JOIN study_members o ON o.study_id = m.study_id AND o.role = 'owner'
    JOIN users ou ON ou.id = o.user_id AND ou.role = 'admin'
    JOIN users mu ON mu.id = m.user_id AND mu.role <> 'admin'
   WHERE m.role = 'member'
   ORDER BY m.study_id, m.added_at, m.user_id;
DELETE FROM study_members s USING users u
 WHERE u.id = s.user_id AND u.role = 'admin'
   AND (s.role <> 'owner' OR s.study_id IN (SELECT study_id FROM _admin_heirs));
UPDATE study_members s SET role = 'owner' FROM _admin_heirs h WHERE s.study_id = h.study_id AND s.user_id = h.user_id;
UPDATE tasks t SET assignee_id = NULL FROM users u WHERE u.id = t.assignee_id AND u.role = 'admin';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_is_admin_matches_role;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_initial_admin;
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_is_admin_matches_role;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('student','professor','admin'));
ALTER TABLE users ADD CONSTRAINT users_is_admin_matches_role CHECK (is_admin = (role = 'admin'));
ALTER TABLE users ADD CONSTRAINT users_initial_admin CHECK (NOT is_owner OR (role = 'admin' AND disabled_at IS NULL));
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK (role IN ('student','professor','admin'));
ALTER TABLE invitations ADD CONSTRAINT invitations_is_admin_matches_role CHECK (is_admin = (role = 'admin'));
