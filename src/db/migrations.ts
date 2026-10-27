// Migrações versionadas. Nunca edite uma migração já aplicada em produção: crie uma nova.
export const migrations: readonly string[] = [
  /* 001 — esquema inicial */ `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE ig_accounts (
    id INTEGER PRIMARY KEY,
    ig_id TEXT NOT NULL UNIQUE,
    app_user_id TEXT,
    username TEXT NOT NULL,
    profile_picture_url TEXT,
    token_enc TEXT,
    token_expires_at INTEGER,
    token_refreshed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'ok'
      CHECK (status IN ('ok', 'reconnect_required', 'paused_by_safety', 'disconnected')),
    messaging_disabled INTEGER NOT NULL DEFAULT 0,
    paused_until INTEGER,
    last_error TEXT,
    connected_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE automations (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL,
    media_type TEXT,
    media_permalink TEXT,
    media_caption TEXT,
    keywords_json TEXT NOT NULL,
    public_variations_json TEXT NOT NULL,
    dm_text TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_variation_index INTEGER,
    last_reconciled_at INTEGER,
    activated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (account_id, media_id)
  );

  CREATE TABLE webhook_events (
    id INTEGER PRIMARY KEY,
    received_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX idx_webhook_events_received ON webhook_events(received_at);

  CREATE TABLE interactions (
    id INTEGER PRIMARY KEY,
    automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    comment_id TEXT NOT NULL UNIQUE,
    commenter_igsid TEXT NOT NULL,
    commenter_username TEXT,
    comment_text TEXT,
    matched_keyword TEXT,
    source TEXT NOT NULL CHECK (source IN ('webhook', 'reconciler')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'done', 'partial', 'failed', 'skipped')),
    skip_reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_interactions_person ON interactions(automation_id, commenter_igsid);
  CREATE INDEX idx_interactions_created ON interactions(created_at);

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    interaction_id INTEGER NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('public_reply', 'private_reply')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_at INTEGER NOT NULL,
    fail_reason TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    result_id TEXT,
    last_attempt_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (interaction_id, type)
  );
  CREATE INDEX idx_jobs_due ON jobs(status, run_at);
  CREATE INDEX idx_jobs_account ON jobs(account_id, status, updated_at);
  CREATE INDEX idx_jobs_account_attempt ON jobs(account_id, last_attempt_at);

  CREATE TABLE deletion_requests (
    code TEXT PRIMARY KEY,
    app_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];
