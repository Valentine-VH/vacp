import pg from 'pg'

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 2000,
})

export async function migrateIdentity() {
  await pool.query(`
    BEGIN;
    SELECT pg_advisory_xact_lock(643211);
    CREATE TABLE IF NOT EXISTS vacp_users (
      id uuid PRIMARY KEY, email text UNIQUE NOT NULL, salt text NOT NULL, secret bytea NOT NULL
    );
    ALTER TABLE vacp_users ADD COLUMN IF NOT EXISTS platform_role text NOT NULL DEFAULT 'user'
      CHECK (platform_role IN ('super_admin','user'));
    CREATE TABLE IF NOT EXISTS vacp_identity_migrations (name text PRIMARY KEY);
    WITH initialization AS (
      INSERT INTO vacp_identity_migrations VALUES ('platform-roles-v1')
      ON CONFLICT DO NOTHING RETURNING name
    )
    UPDATE vacp_users SET platform_role='super_admin'
      WHERE EXISTS (SELECT 1 FROM initialization)
        AND (SELECT count(*) FROM vacp_users)=1;
    CREATE TABLE IF NOT EXISTS vacp_sessions (
      token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES vacp_users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vacp_workspaces (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE IF NOT EXISTS vacp_members (
      workspace_id uuid REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      user_id uuid REFERENCES vacp_users(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
      PRIMARY KEY(workspace_id,user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vacp_workspace_owner ON vacp_members(workspace_id) WHERE role='owner';
    CREATE INDEX IF NOT EXISTS vacp_members_user ON vacp_members(user_id);
    CREATE TABLE IF NOT EXISTS vacp_ownership_transfers (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      from_user_id uuid NOT NULL,
      to_user_id uuid NOT NULL,
      transferred_at timestamptz NOT NULL DEFAULT now(),
      CHECK (from_user_id <> to_user_id)
    );
    CREATE INDEX IF NOT EXISTS vacp_ownership_transfers_recent
      ON vacp_ownership_transfers(workspace_id, transferred_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS vacp_mock_nodes (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      name text NOT NULL, credential text NOT NULL UNIQUE, last_seen timestamptz
    );
    CREATE TABLE IF NOT EXISTS vacp_mock_tasks (
      id uuid PRIMARY KEY, node_id uuid NOT NULL REFERENCES vacp_mock_nodes(id) ON DELETE CASCADE,
      input text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded')),
      result text, lease uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vacp_skills (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      name text NOT NULL, description text NOT NULL, content text NOT NULL, UNIQUE(workspace_id,name)
    );
    CREATE TABLE IF NOT EXISTS vacp_skill_releases (
      id uuid PRIMARY KEY, skill_id uuid NOT NULL REFERENCES vacp_skills(id) ON DELETE CASCADE,
      version text NOT NULL, name text NOT NULL, description text NOT NULL, content text NOT NULL,
      published_at timestamptz NOT NULL DEFAULT now(), UNIQUE(skill_id,version)
    );
    CREATE TABLE IF NOT EXISTS vacp_skill_installs (
      workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      release_id uuid NOT NULL REFERENCES vacp_skill_releases(id) ON DELETE CASCADE,
      PRIMARY KEY(workspace_id,release_id)
    );
    ALTER TABLE vacp_skills ADD COLUMN IF NOT EXISTS origin jsonb;
    CREATE UNIQUE INDEX IF NOT EXISTS vacp_skill_origin_unique ON vacp_skills (
      workspace_id, (origin->>'kind'), (origin->>'label'), (COALESCE(origin->>'version',origin->>'digest'))
    ) WHERE origin IS NOT NULL;
    ALTER TABLE vacp_skill_releases ADD COLUMN IF NOT EXISTS origin jsonb;
    ALTER TABLE vacp_skill_releases
      ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending','approved','rejected','revoked')),
      ADD COLUMN IF NOT EXISTS submitted_by uuid,
      ADD COLUMN IF NOT EXISTS digest text,
      ADD COLUMN IF NOT EXISTS checked_at timestamptz;
    CREATE TABLE IF NOT EXISTS vacp_skill_review_events (
      id uuid PRIMARY KEY, release_id uuid NOT NULL REFERENCES vacp_skill_releases(id) ON DELETE CASCADE,
      actor_id uuid NOT NULL, action text NOT NULL CHECK (action IN ('approved','rejected','revoked')),
      reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vacp_skill_scan_jobs (
      release_id uuid PRIMARY KEY REFERENCES vacp_skill_releases(id) ON DELETE CASCADE,
      digest text NOT NULL, generation uuid, lease_until timestamptz,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','passed','blocked','failed')),
      report jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    );
    ALTER TABLE vacp_skill_scan_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
    UPDATE vacp_skill_releases r SET review_status='pending'
      WHERE r.review_status='approved' AND NOT EXISTS (
        SELECT 1 FROM vacp_skill_scan_jobs j WHERE j.release_id=r.id
      );
    INSERT INTO vacp_skill_scan_jobs(release_id,digest)
      SELECT id,encode(sha256(convert_to(content,'UTF8')),'hex') FROM vacp_skill_releases
      WHERE review_status='pending' ON CONFLICT(release_id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS vacp_mcp_servers (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      name text NOT NULL, endpoint text NOT NULL, auth text NOT NULL CHECK(auth IN ('none','bearer','header')),
      header text, enabled boolean NOT NULL, secret_cipher text, UNIQUE(workspace_id,name),
      CHECK ((auth='header') = (header IS NOT NULL)),
      CHECK ((auth='none') = (secret_cipher IS NULL))
    );
    ALTER TABLE vacp_mock_tasks ADD COLUMN IF NOT EXISTS is_chat boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS vacp_chat_rooms (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('group','direct')), name text, direct_key text,
      updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,direct_key)
    );
    CREATE TABLE IF NOT EXISTS vacp_chat_people (
      room_id uuid REFERENCES vacp_chat_rooms(id) ON DELETE CASCADE,
      user_id uuid REFERENCES vacp_users(id) ON DELETE CASCADE, PRIMARY KEY(room_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS vacp_chat_people_user ON vacp_chat_people(user_id,room_id);
    CREATE TABLE IF NOT EXISTS vacp_chat_agents (
      room_id uuid REFERENCES vacp_chat_rooms(id) ON DELETE CASCADE,
      node_id uuid REFERENCES vacp_mock_nodes(id) ON DELETE CASCADE, PRIMARY KEY(room_id,node_id)
    );
    CREATE TABLE IF NOT EXISTS vacp_chat_messages (
      id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES vacp_chat_rooms(id) ON DELETE CASCADE,
      sender_id uuid NOT NULL REFERENCES vacp_users(id) ON DELETE CASCADE, body text NOT NULL,
      task_id uuid UNIQUE REFERENCES vacp_mock_tasks(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS vacp_chat_messages_recent ON vacp_chat_messages(room_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS vacp_gateway_routes (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      alias text NOT NULL, base_url text NOT NULL, upstream_model text NOT NULL, secret_cipher text NOT NULL,
      enabled boolean NOT NULL DEFAULT true, UNIQUE(workspace_id,alias), UNIQUE(workspace_id,id)
    );
    ALTER TABLE vacp_gateway_routes
      ADD COLUMN IF NOT EXISTS context_window integer NOT NULL DEFAULT 32768,
      ADD COLUMN IF NOT EXISTS max_output_tokens integer NOT NULL DEFAULT 4096,
      ADD COLUMN IF NOT EXISTS compaction_headroom_tokens integer NOT NULL DEFAULT 4096,
      ADD COLUMN IF NOT EXISTS reasoning_efforts text[] NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS vacp_gateway_keys (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, route_id uuid NOT NULL,
      label text NOT NULL, prefix text NOT NULL, token_hash text NOT NULL UNIQUE,
      rpm integer NOT NULL CHECK (rpm BETWEEN 1 AND 600), minute_bucket timestamptz,
      minute_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
      FOREIGN KEY(workspace_id,route_id) REFERENCES vacp_gateway_routes(workspace_id,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS vacp_gateway_keys_workspace ON vacp_gateway_keys(workspace_id);
    ALTER TABLE vacp_gateway_keys ADD COLUMN IF NOT EXISTS use_case text;
    CREATE TABLE IF NOT EXISTS vacp_gateway_usage_hourly (
      workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      bucket timestamptz NOT NULL, model text NOT NULL, user_id uuid, use_case text NOT NULL,
      requests bigint NOT NULL, failed bigint NOT NULL, cancelled bigint NOT NULL,
      reported bigint NOT NULL, input_tokens bigint NOT NULL, output_tokens bigint NOT NULL, total_tokens bigint NOT NULL,
      UNIQUE NULLS NOT DISTINCT(workspace_id,bucket,model,user_id,use_case)
    );
    CREATE TABLE IF NOT EXISTS vacp_gateway_plugin_rate (
      workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES vacp_users(id) ON DELETE CASCADE,
      minute_bucket timestamptz NOT NULL,
      minute_count integer NOT NULL,
      PRIMARY KEY (workspace_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS vacp_plugin_pairings (
      code_hash text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES vacp_users(id) ON DELETE CASCADE,
      plugin text NOT NULL CHECK (plugin IN ('dsh','opencode')), expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vacp_plugin_sessions (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES vacp_users(id) ON DELETE CASCADE,
      plugin text NOT NULL CHECK (plugin IN ('dsh','opencode')), device text NOT NULL,
      plugin_version text NOT NULL, token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days', revoked_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS vacp_plugin_sessions_workspace ON vacp_plugin_sessions(workspace_id,last_seen DESC);
    CREATE TABLE IF NOT EXISTS vacp_plugin_accounts (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES vacp_users(id) ON DELETE CASCADE,
      plugin text NOT NULL CHECK (plugin IN ('dsh','opencode')), device text NOT NULL,
      plugin_version text NOT NULL, token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days'
    );
    ALTER TABLE vacp_plugin_accounts ADD COLUMN IF NOT EXISTS created_at timestamptz;
    ALTER TABLE vacp_plugin_accounts ADD COLUMN IF NOT EXISTS last_seen timestamptz;
    UPDATE vacp_plugin_accounts
      SET created_at=COALESCE(created_at,expires_at-interval '30 days'),
          last_seen=COALESCE(last_seen,created_at,expires_at-interval '30 days')
      WHERE created_at IS NULL OR last_seen IS NULL;
    ALTER TABLE vacp_plugin_accounts ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN created_at SET NOT NULL,
      ALTER COLUMN last_seen SET DEFAULT now(), ALTER COLUMN last_seen SET NOT NULL;
    CREATE INDEX IF NOT EXISTS vacp_plugin_accounts_user ON vacp_plugin_accounts(user_id);
    CREATE TABLE IF NOT EXISTS vacp_plugin_account_instances (
      account_id uuid NOT NULL REFERENCES vacp_plugin_accounts(id) ON DELETE CASCADE,
      id uuid NOT NULL,
      host_name text NOT NULL,
      plugin_version text NOT NULL,
      last_seen timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(account_id,id)
    );
    CREATE INDEX IF NOT EXISTS vacp_plugin_instances_account_seen
      ON vacp_plugin_account_instances(account_id,last_seen DESC);
    ALTER TABLE vacp_plugin_sessions ADD COLUMN IF NOT EXISTS account_id uuid
      REFERENCES vacp_plugin_accounts(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS vacp_plugin_sessions_account ON vacp_plugin_sessions(account_id);
    CREATE TABLE IF NOT EXISTS vacp_plugin_workspace_revocations (
      account_id uuid NOT NULL REFERENCES vacp_plugin_accounts(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      PRIMARY KEY(account_id,workspace_id)
    );
    INSERT INTO vacp_plugin_workspace_revocations(account_id,workspace_id)
      SELECT account_id,workspace_id FROM (
        SELECT DISTINCT ON (account_id,workspace_id) account_id,workspace_id,revoked_at
        FROM vacp_plugin_sessions WHERE account_id IS NOT NULL
        ORDER BY account_id,workspace_id,created_at DESC,id DESC
      ) latest WHERE revoked_at IS NOT NULL ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION vacp_revoke_plugin_password_sessions() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      DELETE FROM vacp_plugin_accounts WHERE user_id=NEW.id;
      RETURN NULL;
    END;
    $fn$;
    DROP TRIGGER IF EXISTS vacp_plugin_password_changed ON vacp_users;
    CREATE TRIGGER vacp_plugin_password_changed AFTER UPDATE OF salt,secret ON vacp_users
      FOR EACH ROW WHEN (OLD.salt IS DISTINCT FROM NEW.salt OR OLD.secret IS DISTINCT FROM NEW.secret)
      EXECUTE FUNCTION vacp_revoke_plugin_password_sessions();
    CREATE OR REPLACE FUNCTION vacp_revoke_member_plugin_access() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' OR (NEW.role = 'viewer' AND OLD.role <> 'viewer') THEN
        DELETE FROM vacp_plugin_pairings WHERE workspace_id=OLD.workspace_id AND user_id=OLD.user_id;
        UPDATE vacp_plugin_sessions SET revoked_at=now()
          WHERE workspace_id=OLD.workspace_id AND user_id=OLD.user_id AND revoked_at IS NULL;
      END IF;
      RETURN NULL;
    END;
    $fn$;
    DROP TRIGGER IF EXISTS vacp_member_plugin_access ON vacp_members;
    CREATE TRIGGER vacp_member_plugin_access AFTER DELETE OR UPDATE OF role ON vacp_members
      FOR EACH ROW EXECUTE FUNCTION vacp_revoke_member_plugin_access();
    CREATE TABLE IF NOT EXISTS vacp_plugin_profiles (
      workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      plugin text NOT NULL CHECK(plugin IN ('dsh','opencode')),
      route_id uuid, skill_ids uuid[] NOT NULL DEFAULT '{}', mcp_ids uuid[] NOT NULL DEFAULT '{}',
      rpm integer NOT NULL DEFAULT 30 CHECK(rpm BETWEEN 1 AND 600),
      PRIMARY KEY(workspace_id,plugin),
      FOREIGN KEY(workspace_id,route_id) REFERENCES vacp_gateway_routes(workspace_id,id) ON DELETE CASCADE
    );
    ALTER TABLE vacp_gateway_keys ADD COLUMN IF NOT EXISTS plugin_session_id uuid
      REFERENCES vacp_plugin_sessions(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS vacp_gateway_keys_plugin_session ON vacp_gateway_keys(plugin_session_id)
      WHERE plugin_session_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS vacp_plugin_github_sources (
      workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      repo_id bigint NOT NULL,
      host text NOT NULL CHECK(host IN ('dsh','opencode')),
      source jsonb NOT NULL,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(workspace_id,repo_id,host)
    );
    CREATE TABLE IF NOT EXISTS vacp_remote_prompts (
      workspace_id uuid NOT NULL REFERENCES vacp_workspaces(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES vacp_users(id) ON DELETE CASCADE,
      id uuid NOT NULL,
      fingerprint text NOT NULL,
      status text NOT NULL CHECK(status IN ('pending','accepted','rejected','unknown')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(workspace_id,user_id,id)
    );
    CREATE TABLE IF NOT EXISTS vacp_file_relay_settings (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      enabled boolean NOT NULL DEFAULT true,
      max_files integer NOT NULL DEFAULT 3 CHECK(max_files BETWEEN 1 AND 3),
      max_total_kib integer NOT NULL DEFAULT 256 CHECK(max_total_kib BETWEEN 1 AND 256),
      max_concurrent integer NOT NULL DEFAULT 4 CHECK(max_concurrent BETWEEN 1 AND 16)
    );
    INSERT INTO vacp_file_relay_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
    COMMIT;
  `)
}
