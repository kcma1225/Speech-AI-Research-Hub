-- Structured person names: Chinese family/given name (both required by the API), English family name (required) and
-- given name (optional), and an optional title code (稱謂). `real_name` stays the Chinese full name, now derived from
-- the Chinese parts on every API write (lib/users/person-name.ts composeZhName); `name` stays its generated copy.
-- `name_en` is the English display without title ("Given Family" / "Family"), NULL when unknown.
-- The parts are nullable at the database level only for rows inserted outside the API (tests); screens fall back to
-- `name`. The data step `backfillPersonNames` (run by migrate() right after this file, same transaction) splits every
-- existing real name; `names_confirmed_at` stays NULL for those accounts so the app asks them once to confirm.

ALTER TABLE users
  ADD COLUMN zh_family text CHECK (zh_family IS NULL OR zh_family = btrim(zh_family)),
  ADD COLUMN zh_given text CHECK (zh_given IS NULL OR zh_given = btrim(zh_given)),
  ADD COLUMN en_family text CHECK (en_family IS NULL OR (en_family = btrim(en_family) AND length(en_family) BETWEEN 1 AND 40)),
  ADD COLUMN en_given text CHECK (en_given IS NULL OR (en_given = btrim(en_given) AND length(en_given) BETWEEN 1 AND 40)),
  ADD COLUMN title text CHECK (title IS NULL OR title IN ('mr', 'ms', 'mx', 'dr', 'prof')),
  ADD COLUMN names_confirmed_at timestamptz;

ALTER TABLE users ADD COLUMN name_en text GENERATED ALWAYS AS (
  CASE WHEN en_family IS NULL THEN NULL WHEN en_given IS NULL THEN en_family ELSE en_given || ' ' || en_family END
) STORED;
