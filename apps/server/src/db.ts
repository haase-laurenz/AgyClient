import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentLogEntry, ManagedAgentSession } from '@agy-client/process-manager';
import { WorkflowRun } from '@agy-client/orchestrator';
import { DEFAULT_MODEL_BUDGETS, ModelBudgetConfig } from '@agy-client/usage';

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityAuditEntry {
  id: string;
  timestamp: string;
  action: string;
  actor: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  details: string;
}

export class AgyDatabase {
  private readonly db: DatabaseSyncType;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT,
        workspace_path TEXT NOT NULL,
        worktree_path TEXT,
        branch_name TEXT,
        conversation_id TEXT,
        parent_session_id TEXT,
        execution_role TEXT NOT NULL,
        allow_subagents INTEGER NOT NULL DEFAULT 1,
        subagent_role TEXT,
        fast_response INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        mode TEXT NOT NULL,
        sandbox INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        pid INTEGER,
        prompt TEXT NOT NULL,
        last_response TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        thinking_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0,
        duration_seconds REAL NOT NULL DEFAULT 0,
        exit_code INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        stream TEXT NOT NULL,
        text TEXT NOT NULL,
        raw_event_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_logs_session ON agent_logs(session_id, timestamp);

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        details TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_budgets (
        family TEXT PRIMARY KEY,
        window_hours INTEGER NOT NULL,
        max_tokens INTEGER NOT NULL,
        max_requests INTEGER NOT NULL
      );
    `);

    // Migrate existing databases to ensure allow_subagents and subagent_role columns exist
    try {
      this.db.exec(`ALTER TABLE agent_sessions ADD COLUMN allow_subagents INTEGER NOT NULL DEFAULT 1;`);
    } catch {
      // column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agent_sessions ADD COLUMN subagent_role TEXT;`);
    } catch {
      // column already exists
    }
    try {
      this.db.exec(`ALTER TABLE agent_sessions ADD COLUMN fast_response INTEGER NOT NULL DEFAULT 0;`);
    } catch {
      // column already exists
    }

    // Seed default model budgets if empty
    const budgetCount = this.db
      .prepare('SELECT COUNT(*) as cnt FROM model_budgets')
      .get() as { cnt: number };
    if (budgetCount.cnt === 0) {
      const insertBudget = this.db.prepare(
        'INSERT INTO model_budgets (family, window_hours, max_tokens, max_requests) VALUES (?, ?, ?, ?)'
      );
      for (const b of DEFAULT_MODEL_BUDGETS) {
        insertBudget.run(b.family, b.windowHours, b.maxTokens, b.maxRequests);
      }
    }
  }

  public seedProjectsFromWorkspaces(workspacePaths: string[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO projects (id, name, path, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const rawPath of workspacePaths) {
      if (!rawPath || !fs.existsSync(rawPath)) continue;
      const resolved = path.resolve(rawPath);
      const name = path.basename(resolved) || resolved;
      stmt.run(
        crypto.randomUUID(),
        name,
        resolved,
        'Imported from Antigravity trustedWorkspaces',
        now,
        now
      );
    }
  }

  public listProjects(): ProjectRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      path: String(r.path),
      description: String(r.description ?? ''),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  public createProject(input: { name: string; path: string; description?: string }): ProjectRecord {
    const resolved = path.resolve(input.path.trim());
    if (!fs.existsSync(resolved)) {
      throw new Error(`Project path does not exist on disk: ${resolved}`);
    }
    const existing = this.db
      .prepare('SELECT * FROM projects WHERE LOWER(path) = LOWER(?)')
      .get(resolved) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        id: String(existing.id),
        name: String(existing.name),
        path: String(existing.path),
        description: String(existing.description ?? ''),
        createdAt: String(existing.created_at),
        updatedAt: String(existing.updated_at),
      };
    }

    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: crypto.randomUUID(),
      name: input.name.trim() || path.basename(resolved),
      path: resolved,
      description: input.description?.trim() || '',
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        'INSERT INTO projects (id, name, path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        project.id,
        project.name,
        project.path,
        project.description,
        project.createdAt,
        project.updatedAt
      );

    return project;
  }

  public deleteProject(id: string): boolean {
    const res = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  public saveSession(s: ManagedAgentSession): void {
    if (this.closed) return;
    const stmt = this.db.prepare(`
      INSERT INTO agent_sessions (
        id, title, project_id, workspace_path, worktree_path, branch_name,
        conversation_id, parent_session_id, execution_role, allow_subagents, subagent_role,
        fast_response, model, effort, mode, sandbox, status, pid, prompt, last_response,
        input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens,
        turn_count, duration_seconds, exit_code, error, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        worktree_path = excluded.worktree_path,
        branch_name = excluded.branch_name,
        conversation_id = excluded.conversation_id,
        parent_session_id = excluded.parent_session_id,
        execution_role = excluded.execution_role,
        allow_subagents = excluded.allow_subagents,
        subagent_role = excluded.subagent_role,
        fast_response = excluded.fast_response,
        model = excluded.model,
        effort = excluded.effort,
        status = excluded.status,
        pid = excluded.pid,
        prompt = excluded.prompt,
        last_response = excluded.last_response,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        thinking_tokens = excluded.thinking_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        total_tokens = excluded.total_tokens,
        turn_count = excluded.turn_count,
        duration_seconds = excluded.duration_seconds,
        exit_code = excluded.exit_code,
        error = excluded.error,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      s.id,
      s.title,
      s.projectId,
      s.workspacePath,
      s.worktreePath,
      s.branchName,
      s.conversationId,
      s.parentSessionId,
      s.executionRole,
      s.allowSubagents === false ? 0 : 1,
      s.subagentRole ?? null,
      s.fastResponse ? 1 : 0,
      s.model,
      s.effort,
      s.mode,
      s.sandbox ? 1 : 0,
      s.status,
      s.pid,
      s.prompt,
      s.lastResponse,
      s.inputTokens,
      s.outputTokens,
      s.thinkingTokens,
      s.cacheReadTokens,
      s.totalTokens,
      s.turnCount,
      s.durationSeconds,
      s.exitCode,
      s.error,
      s.createdAt,
      s.updatedAt
    );
  }

  public loadSessions(): ManagedAgentSession[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      projectId: r.project_id ? String(r.project_id) : null,
      workspacePath: String(r.workspace_path),
      worktreePath: r.worktree_path ? String(r.worktree_path) : null,
      branchName: r.branch_name ? String(r.branch_name) : null,
      conversationId: r.conversation_id ? String(r.conversation_id) : null,
      parentSessionId: r.parent_session_id ? String(r.parent_session_id) : null,
      executionRole: (r.execution_role as ManagedAgentSession['executionRole']) || 'independent',
      allowSubagents:
        r.allow_subagents !== undefined && r.allow_subagents !== null
          ? Boolean(Number(r.allow_subagents))
          : true,
      subagentRole: r.subagent_role ? String(r.subagent_role) : null,
      fastResponse: Boolean(Number(r.fast_response ?? 0)),
      model: String(r.model),
      effort: (r.effort as ManagedAgentSession['effort']) || 'medium',
      mode: (r.mode as ManagedAgentSession['mode']) || 'auto',
      sandbox: Boolean(r.sandbox),
      status: (r.status as ManagedAgentSession['status']) || 'stopped',
      pid: r.pid !== null && r.pid !== undefined ? Number(r.pid) : null,
      prompt: String(r.prompt),
      lastResponse: String(r.last_response ?? ''),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      thinkingTokens: Number(r.thinking_tokens ?? 0),
      cacheReadTokens: Number(r.cache_read_tokens ?? 0),
      totalTokens: Number(r.total_tokens ?? 0),
      turnCount: Number(r.turn_count ?? 0),
      durationSeconds: Number(r.duration_seconds ?? 0),
      exitCode: r.exit_code !== null && r.exit_code !== undefined ? Number(r.exit_code) : null,
      error: r.error ? String(r.error) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  public appendLog(entry: AgentLogEntry): void {
    if (this.closed) return;
    this.db
      .prepare(
        'INSERT INTO agent_logs (id, session_id, timestamp, stream, text, raw_event_json) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        entry.id,
        entry.sessionId,
        entry.timestamp,
        entry.stream,
        entry.text,
        entry.rawEvent ? JSON.stringify(entry.rawEvent) : null
      );
  }

  public loadSessionLogs(sessionId: string, limit = 2500): AgentLogEntry[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_logs WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?'
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      timestamp: String(r.timestamp),
      stream: r.stream as AgentLogEntry['stream'],
      text: String(r.text),
      rawEvent:
        typeof r.raw_event_json === 'string' && r.raw_event_json
          ? JSON.parse(r.raw_event_json)
          : undefined,
    }));
  }

  public saveWorkflow(wf: WorkflowRun): void {
    if (this.closed) return;
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, status, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           status = excluded.status,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .run(wf.id, wf.name, wf.status, JSON.stringify(wf), wf.createdAt, wf.updatedAt);
  }

  public loadWorkflows(): WorkflowRun[] {
    const rows = this.db
      .prepare('SELECT payload_json FROM workflows ORDER BY updated_at DESC')
      .all() as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as WorkflowRun);
  }

  public addAuditLog(input: {
    action: string;
    actor?: string;
    riskLevel: SecurityAuditEntry['riskLevel'];
    details: string;
  }): SecurityAuditEntry {
    const entry: SecurityAuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      action: input.action,
      actor: input.actor || 'local-user',
      riskLevel: input.riskLevel,
      details: input.details,
    };
    this.db
      .prepare(
        'INSERT INTO audit_logs (id, timestamp, action, actor, risk_level, details) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(entry.id, entry.timestamp, entry.action, entry.actor, entry.riskLevel, entry.details);
    return entry;
  }

  public listAuditLogs(limit = 100): SecurityAuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      timestamp: String(r.timestamp),
      action: String(r.action),
      actor: String(r.actor),
      riskLevel: r.risk_level as SecurityAuditEntry['riskLevel'],
      details: String(r.details),
    }));
  }

  public loadModelBudgets(): ModelBudgetConfig[] {
    const rows = this.db
      .prepare('SELECT * FROM model_budgets ORDER BY family ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      family: String(r.family),
      windowHours: Number(r.window_hours),
      maxTokens: Number(r.max_tokens),
      maxRequests: Number(r.max_requests),
    }));
  }

  public saveModelBudgets(budgets: ModelBudgetConfig[]): ModelBudgetConfig[] {
    this.db.exec('DELETE FROM model_budgets');
    const stmt = this.db.prepare(
      'INSERT INTO model_budgets (family, window_hours, max_tokens, max_requests) VALUES (?, ?, ?, ?)'
    );
    for (const b of budgets) {
      stmt.run(b.family, b.windowHours, b.maxTokens, b.maxRequests);
    }
    return this.loadModelBudgets();
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
