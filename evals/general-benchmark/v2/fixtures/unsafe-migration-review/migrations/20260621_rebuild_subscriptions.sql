BEGIN;

DROP TABLE subscriptions;

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_account_idx ON subscriptions(account_id);

COMMIT;
