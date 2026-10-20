-- OpenID Connect provider for Aldine (backend/src/routes/oidc.ts, docs/architecture.md "OIDC provider").

-- ID-token signing key, created on first use. The private key never leaves the backend/DB; the JWKS publishes
-- `public_jwk`. Exactly one key is active; inactive keys stay published until removed by hand (rotation).
CREATE TABLE oidc_signing_keys (
  kid text PRIMARY KEY,
  alg text NOT NULL CHECK (alg IN ('ES256')),
  private_key_pem text NOT NULL,
  public_jwk jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX oidc_signing_keys_one_active ON oidc_signing_keys(active) WHERE active;

-- One-time authorization codes (sha256 of the code), ~60 s TTL; consumed with DELETE … RETURNING.
CREATE TABLE oidc_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  nonce text,
  code_challenge text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_codes_expires ON oidc_codes(expires_at);

-- Opaque access tokens for /api/oidc/userinfo (sha256 of the token), short-lived.
CREATE TABLE oidc_access_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_access_tokens_expires ON oidc_access_tokens(expires_at);
