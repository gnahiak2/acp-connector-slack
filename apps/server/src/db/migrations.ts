export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        executable TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '[]',
        runner TEXT NOT NULL CHECK (runner IN ('local','container')),
        authentication TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        preset INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        local_path TEXT,
        repository TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        allowed_channels TEXT NOT NULL DEFAULT '[]',
        allowed_users TEXT NOT NULL DEFAULT '[]',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL CHECK (origin IN ('slack','dashboard')),
        team_id TEXT,
        channel_id TEXT,
        thread_ts TEXT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        creator_id TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        acp_session_id TEXT,
        workspace_path TEXT NOT NULL,
        access_policy TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        archived_at TEXT,
        last_error TEXT,
        UNIQUE (team_id, channel_id, thread_ts)
      );
      CREATE INDEX idx_sessions_status ON sessions(status, last_activity_at DESC);
      CREATE INDEX idx_sessions_channel ON sessions(channel_id, last_activity_at DESC);
      CREATE INDEX idx_sessions_project ON sessions(project_id, last_activity_at DESC);

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        stop_reason TEXT,
        error TEXT
      );
      CREATE INDEX idx_jobs_status ON jobs(status, created_at);
      CREATE INDEX idx_jobs_session ON jobs(session_id, created_at DESC);

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        job_id TEXT,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );
      CREATE INDEX idx_events_session ON events(session_id, seq);
      CREATE INDEX idx_events_job ON events(job_id, id);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        job_id TEXT,
        kind TEXT NOT NULL,
        tool_call_id TEXT,
        title TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        options TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        requested_by TEXT,
        resolved_by TEXT,
        option_id TEXT,
        resolution TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX idx_approvals_pending ON approvals(status, expires_at);
      CREATE INDEX idx_approvals_session ON approvals(session_id, created_at DESC);

      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        version TEXT NOT NULL,
        content TEXT NOT NULL,
        refs TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        content TEXT NOT NULL,
        refs TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (skill_id, version)
      );

      CREATE TABLE session_skills (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        enabled_at TEXT NOT NULL,
        PRIMARY KEY (session_id, skill_id)
      );

      CREATE TABLE memory (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT,
        content TEXT NOT NULL,
        provenance TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX idx_memory_project ON memory(project_id, status, updated_at DESC);

      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        env_refs TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        header_refs TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        detail TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

      CREATE TABLE slack_dedupe (
        event_key TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      );

      CREATE TABLE channel_defaults (
        channel_id TEXT PRIMARY KEY,
        agent_id TEXT,
        project_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];
