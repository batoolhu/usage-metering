CREATE TABLE plans (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('account','user')),
  name TEXT NOT NULL,
  monthly_allowance BIGINT NOT NULL CHECK (monthly_allowance >= 0),
  max_per_request BIGINT NOT NULL CHECK (max_per_request > 0),
  is_predefined BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  plan_id BIGINT NOT NULL REFERENCES plans(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE plans
  ADD CONSTRAINT plans_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id);

CREATE UNIQUE INDEX plans_predefined_name_uq
  ON plans (kind, name) WHERE account_id IS NULL;

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  external_id TEXT NOT NULL,
  plan_id BIGINT NOT NULL REFERENCES plans(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

CREATE TABLE account_usage (
  account_id BIGINT REFERENCES accounts(id),
  month DATE,
  consumed BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

CREATE TABLE user_usage (
  user_id BIGINT REFERENCES users(id),
  month DATE,
  consumed BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE requests (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  units BIGINT NOT NULL,
  accepted BOOLEAN,
  rejected_by TEXT,
  rejected_rule TEXT,
  month DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id)
);

CREATE INDEX requests_history_idx
  ON requests (account_id, created_at DESC, id DESC);