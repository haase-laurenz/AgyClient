import http, { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { AgyCliAdapter, AgyExecutionMode, AgyReasoningEffort } from '@agy-client/agy-adapter';
import {
  PERMISSION_PRESETS,
  PermissionScope,
  PermissionsManager,
} from '@agy-client/permissions';
import { ModelBudgetConfig, UsageTracker } from '@agy-client/usage';
import { ProcessManager } from '@agy-client/process-manager';
import { GitWorktreeManager } from '@agy-client/git-manager';
import {
  BUILTIN_WORKFLOW_TEMPLATES,
  WorkflowOrchestrator,
  WorkflowTaskDefinition,
} from '@agy-client/orchestrator';
import { AgyDatabase } from './db.js';

export interface AgyServerOptions {
  dbPath?: string;
  agyBin?: string;
  appDataDir?: string;
  settingsPath?: string;
  backupDir?: string;
  staticDir?: string;
  apiToken?: string;
  defaultWorkspacePath?: string;
}

export interface AgyServerInstance {
  server: http.Server;
  wss: WebSocketServer;
  db: AgyDatabase;
  adapter: AgyCliAdapter;
  permissions: PermissionsManager;
  usage: UsageTracker;
  processManager: ProcessManager;
  gitManager: GitWorktreeManager;
  orchestrator: WorkflowOrchestrator;
  close: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function isAllowedLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const hostname = hostHeader.split(':')[0].toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function isAllowedLocalOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  try {
    const u = new URL(originHeader);
    return (
      u.hostname === '127.0.0.1' ||
      u.hostname === 'localhost' ||
      u.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

export function createAgyServer(options: AgyServerOptions = {}): AgyServerInstance {
  const defaultWorkspace = options.defaultWorkspacePath || process.cwd();
  const dbPath =
    options.dbPath || path.join(defaultWorkspace, '.agy-client', 'agyclient.db');

  const db = new AgyDatabase(dbPath);
  const adapter = new AgyCliAdapter({
    appDataDir: options.appDataDir,
    agyBin: options.agyBin,
  });
  const permissions = new PermissionsManager({
    settingsPath: options.settingsPath,
    backupDir: options.backupDir,
  });

  // Seed projects from trustedWorkspaces + current workspace
  const currentSettings = permissions.readSettings();
  db.seedProjectsFromWorkspaces([
    defaultWorkspace,
    ...currentSettings.trustedWorkspaces,
  ]);

  const initialSessions = db.loadSessions();
  const processManager = new ProcessManager({
    agyBin: options.agyBin,
    initialSessions,
    hooks: {
      onSessionSave: (s) => db.saveSession(s),
      onLogAppend: (l) => db.appendLog(l),
    },
  });

  for (const s of initialSessions) {
    processManager.hydrateSessionLogs(s.id, db.loadSessionLogs(s.id, 2500));
  }

  const gitManager = new GitWorktreeManager();
  const orchestrator = new WorkflowOrchestrator({
    processManager,
    gitManager,
    initialWorkflows: db.loadWorkflows(),
    onWorkflowSave: (wf) => db.saveWorkflow(wf),
  });

  const usage = new UsageTracker({
    adapter,
    budgets: db.loadModelBudgets(),
  });

  let cachedCliVersion: { installed: boolean; version: string | null } | null = null;
  let cachedModels = AgyCliAdapter.getFallbackModels();

  const server = http.createServer(async (req, res) => {
    try {
      // 1. Validate local Host header (prevent DNS rebinding)
      if (!isAllowedLocalHost(req.headers.host)) {
        sendJson(res, 403, { error: 'Forbidden Host header. Only 127.0.0.1 / localhost allowed.' });
        return;
      }

      // 2. Validate Origin header for state-changing requests
      const method = req.method || 'GET';
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        if (!isAllowedLocalOrigin(req.headers.origin)) {
          sendJson(res, 403, {
            error: 'Forbidden Origin header. Only local origin requests are permitted.',
          });
          return;
        }
      }

      // 3. Optional local API token check
      if (options.apiToken) {
        const provided = req.headers['x-agy-token'];
        if (req.url?.startsWith('/api/') && provided !== options.apiToken) {
          sendJson(res, 401, { error: 'Unauthorized: valid X-Agy-Token header required.' });
          return;
        }
      }

      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = parsedUrl.pathname;

      // API Routes
      if (pathname === '/api/health' && method === 'GET') {
        if (!cachedCliVersion) {
          cachedCliVersion = adapter.getVersion();
        }
        const sessions = processManager.listSessions();
        const activeCount = sessions.filter(
          (s) => s.status === 'running' || s.status === 'starting'
        ).length;
        sendJson(res, 200, {
          status: 'ok',
          appName: 'AgyClient',
          boundHost: '127.0.0.1',
          agyCli: cachedCliVersion,
          activeProcesses: activeCount,
          totalManagedSessions: sessions.length,
          defaultWorkspacePath: defaultWorkspace,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (pathname === '/api/models' && method === 'GET') {
        if ( parsedUrl.searchParams.get('refresh') === 'true') {
          cachedModels = adapter.listModels();
        }
        sendJson(res, 200, { models: cachedModels });
        return;
      }

      // Projects API
      if (pathname === '/api/projects' && method === 'GET') {
        const projects = db.listProjects().map((p) => ({
          ...p,
          isGitRepo: gitManager.isGitRepo(p.path),
          currentBranch: gitManager.isGitRepo(p.path) ? gitManager.getCurrentBranch(p.path) : null,
          deleteProtected: permissions.checkDirectoryDeleteProtection(p.path).protected,
        }));
        sendJson(res, 200, { projects });
        return;
      }

      if (pathname === '/api/projects' && method === 'POST') {
        const body = await readJsonBody<{ name?: string; path?: string; description?: string }>(req);
        if (!body.path) {
          sendJson(res, 400, { error: 'Project path is required.' });
          return;
        }
        const project = db.createProject({
          name: body.name || path.basename(body.path),
          path: body.path,
          description: body.description,
        });
        sendJson(res, 201, { project });
        return;
      }

      if (pathname.startsWith('/api/projects/') && method === 'DELETE') {
        const id = decodeURIComponent(pathname.slice('/api/projects/'.length));
        const deleted = db.deleteProject(id);
        sendJson(res, 200, { deleted });
        return;
      }

      // Sessions & Process Manager API
      if (pathname === '/api/sessions' && method === 'GET') {
        const managedSessions = processManager.listSessions();
        const cliConversations = adapter.listCliConversations(60);
        sendJson(res, 200, {
          sessions: managedSessions,
          cliConversations,
        });
        return;
      }

      if (pathname === '/api/sessions' && method === 'POST') {
        const body = await readJsonBody<{
          title?: string;
          projectId?: string | null;
          workspacePath?: string;
          parentSessionId?: string | null;
          allowSubagents?: boolean;
          subagentRole?: string | null;
          fastResponse?: boolean;
          prompt?: string;
          prompts?: string[];
          model?: string;
          effort?: AgyReasoningEffort;
          mode?: AgyReasoningEffort | AgyExecutionMode;
          sandbox?: boolean;
          useWorktree?: boolean;
          timeoutSeconds?: number;
        }>(req);

        const workspacePath = body.workspacePath || defaultWorkspace;
        const promptList =
          Array.isArray(body.prompts) && body.prompts.length > 0
            ? body.prompts.filter((p) => p && p.trim())
            : body.prompt?.trim()
            ? [body.prompt.trim()]
            : [];

        if (promptList.length === 0) {
          sendJson(res, 400, { error: 'At least one prompt is required to launch an agent.' });
          return;
        }

        const launched = [];
        for (let i = 0; i < promptList.length; i++) {
          const promptText = promptList[i];
          let worktreePath: string | null = null;
          let branchName: string | null = null;

          if (body.useWorktree) {
            const slug = `${(body.title || 'task').slice(0, 20)}-${Date.now().toString(36)}-${i + 1}`;
            const wt = gitManager.createWorktree(workspacePath, slug);
            worktreePath = wt.worktreePath;
            branchName = wt.branch;
          }

          const sessionTitle =
            promptList.length > 1 && body.title
              ? `${body.title} (#${i + 1})`
              : body.title || promptText.slice(0, 65);

          const session = body.parentSessionId
            ? processManager.spawnSubagent(body.parentSessionId, {
                title: sessionTitle,
                prompt: promptText,
                subagentRole: body.subagentRole || 'SubAgent',
                fastResponse: body.fastResponse,
                model: body.model,
                effort: body.effort,
                mode: body.mode as AgyExecutionMode | undefined,
                sandbox: body.sandbox,
                worktreePath: worktreePath ?? undefined,
                branchName: branchName ?? undefined,
                allowSubagents: body.allowSubagents ?? false,
                timeoutSeconds: body.timeoutSeconds,
              })
            : processManager.startSession({
                title: sessionTitle,
                projectId: body.projectId ?? null,
                workspacePath,
                worktreePath,
                branchName,
                allowSubagents: body.allowSubagents ?? true,
                subagentRole: body.subagentRole ?? null,
                fastResponse: Boolean(body.fastResponse),
                prompt: promptText,
                model:
                  body.model ||
                  (body.fastResponse ? 'gemini-3.8-flash-low' : 'gemini-4-argon-medium'),
                effort: body.effort || (body.fastResponse ? 'low' : 'medium'),
                mode: (body.mode as AgyExecutionMode) || 'auto',
                sandbox: Boolean(body.sandbox),
                timeoutSeconds: body.timeoutSeconds,
              });
          launched.push(session);
        }

        sendJson(res, 201, {
          session: launched[0],
          sessions: launched,
        });
        return;
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(logs|prompt|stop|subagents))?$/.exec(pathname);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const subAction = sessionMatch[2];

        if (!subAction && method === 'GET') {
          const session = processManager.getSession(sessionId);
          if (!session) {
            // Check if it's a native CLI conversation ID
            const transcript = adapter.readConversationTranscript(sessionId);
            if (transcript.length > 0) {
              sendJson(res, 200, {
                session: null,
                logs: [],
                transcript,
                subagents: [],
              });
              return;
            }
            sendJson(res, 404, { error: `Session "${sessionId}" not found.` });
            return;
          }
          const logs = processManager.getSessionLogs(sessionId);
          const subagents = processManager.getSubagents(sessionId);
          const transcript = session.conversationId
            ? adapter.readConversationTranscript(session.conversationId)
            : [];
          sendJson(res, 200, { session, logs, transcript, subagents });
          return;
        }

        if (subAction === 'subagents' && method === 'GET') {
          const subagents = processManager.getSubagents(sessionId);
          sendJson(res, 200, { subagents });
          return;
        }

        if (subAction === 'subagents' && method === 'POST') {
          const body = await readJsonBody<{
            title?: string;
            subagentRole?: string;
            fastResponse?: boolean;
            prompt?: string;
            prompts?: string[];
            tasks?: Array<{ title?: string; role?: string; prompt: string; model?: string }>;
            model?: string;
            effort?: AgyReasoningEffort;
            mode?: AgyExecutionMode;
            sandbox?: boolean;
            useWorktree?: boolean;
            allowSubagents?: boolean;
            timeoutSeconds?: number;
          }>(req);

          const parent = processManager.getSession(sessionId);
          if (!parent) {
            sendJson(res, 404, { error: `Parent session "${sessionId}" not found.` });
            return;
          }

          const taskItems: Array<{ title?: string; role?: string; prompt: string; model?: string }> =
            Array.isArray(body.tasks) && body.tasks.length > 0
              ? body.tasks.filter((t) => t && t.prompt && t.prompt.trim())
              : Array.isArray(body.prompts) && body.prompts.length > 0
              ? body.prompts
                  .filter((p) => p && p.trim())
                  .map((p, idx) => ({
                    title:
                      body.prompts!.length > 1 && body.title
                        ? `${body.title} (#${idx + 1})`
                        : body.title,
                    role: body.subagentRole,
                    prompt: p.trim(),
                  }))
              : body.prompt?.trim()
              ? [{ title: body.title, role: body.subagentRole, prompt: body.prompt.trim() }]
              : [];

          if (taskItems.length === 0) {
            sendJson(res, 400, { error: 'At least one SubAgent prompt is required.' });
            return;
          }

          const spawned = [];
          for (let i = 0; i < taskItems.length; i++) {
            const item = taskItems[i];
            let worktreePath: string | null | undefined = undefined;
            let branchName: string | null | undefined = undefined;

            if (body.useWorktree) {
              const slug = `sub-${(item.title || item.role || 'task').slice(0, 16)}-${Date.now().toString(36)}-${i + 1}`;
              try {
                const wt = gitManager.createWorktree(parent.workspacePath, slug);
                worktreePath = wt.worktreePath;
                branchName = wt.branch;
              } catch {
                // fallback to parent workspace
              }
            }

            const sub = processManager.spawnSubagent(sessionId, {
              title: item.title,
              subagentRole: item.role || body.subagentRole || 'SubAgent',
              fastResponse: body.fastResponse,
              prompt: item.prompt,
              model: item.model || body.model,
              effort: body.effort,
              mode: body.mode,
              sandbox: body.sandbox,
              worktreePath,
              branchName,
              allowSubagents: body.allowSubagents ?? false,
              timeoutSeconds: body.timeoutSeconds,
            });
            spawned.push(sub);
          }

          sendJson(res, 201, {
            subagent: spawned[0],
            subagents: spawned,
          });
          return;
        }

        if (subAction === 'logs' && method === 'GET') {
          const logs = processManager.getSessionLogs(sessionId);
          sendJson(res, 200, { logs });
          return;
        }

        if (subAction === 'prompt' && method === 'POST') {
          const body = await readJsonBody<{
            prompt?: string;
            timeoutSeconds?: number;
            fastResponse?: boolean;
            effort?: AgyReasoningEffort;
            model?: string;
          }>(req);
          if (!body.prompt || !body.prompt.trim()) {
            sendJson(res, 400, { error: 'Follow-up prompt cannot be empty.' });
            return;
          }
          const updated = processManager.sendFollowUpPrompt(
            sessionId,
            body.prompt.trim(),
            body.timeoutSeconds,
            {
              fastResponse: body.fastResponse,
              effort: body.effort,
              model: body.model,
            }
          );
          sendJson(res, 200, { session: updated });
          return;
        }

        if (subAction === 'stop' && method === 'POST') {
          const stopped = processManager.stopSession(sessionId);
          sendJson(res, 200, { session: stopped });
          return;
        }
      }

      // Permissions & Security Rules API
      if (pathname === '/api/permissions' && method === 'GET') {
        const settings = permissions.readSettings();
        const backups = permissions.listBackups();
        const auditLogs = db.listAuditLogs(50);
        sendJson(res, 200, {
          settingsPath: permissions.getSettingsPath(),
          settings,
          presets: PERMISSION_PRESETS,
          backups,
          auditLogs,
        });
        return;
      }

      if (pathname === '/api/permissions' && method === 'PUT') {
        const body = await readJsonBody<{
          permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
          trustedWorkspaces?: string[];
          confirmSecurityChange?: boolean;
          reason?: string;
        }>(req);

        if (!body.confirmSecurityChange) {
          sendJson(res, 400, {
            error:
              'Explicit confirmation (confirmSecurityChange: true) is required to modify security rules.',
          });
          return;
        }

        const result = permissions.updateSettings({
          permissions: body.permissions,
          trustedWorkspaces: body.trustedWorkspaces,
        });

        const audit = db.addAuditLog({
          action: 'permissions.update',
          riskLevel: 'high',
          details:
            body.reason ||
            `Updated settings.json permissions (Allow=${result.settings.permissions.allow.length}, Ask=${result.settings.permissions.ask.length}, Deny=${result.settings.permissions.deny.length}). Backup: ${result.backup?.filename ?? 'none'}`,
        });
        broadcast({ type: 'audit:logged', audit });

        sendJson(res, 200, {
          settings: result.settings,
          backup: result.backup,
          audit,
        });
        return;
      }

      if (pathname === '/api/permissions/evaluate' && method === 'POST') {
        const body = await readJsonBody<{ scope?: PermissionScope; target?: string }>(req);
        const scope = body.scope || 'command';
        const target = body.target ?? '';
        const evaluation = permissions.evaluateAction(scope, target);
        sendJson(res, 200, { evaluation });
        return;
      }

      if (pathname === '/api/permissions/restore' && method === 'POST') {
        const body = await readJsonBody<{ backupId?: string; confirmSecurityChange?: boolean }>(req);
        if (!body.confirmSecurityChange || !body.backupId) {
          sendJson(res, 400, {
            error: 'Both backupId and confirmSecurityChange: true are required.',
          });
          return;
        }
        const restored = permissions.restoreBackup(body.backupId);
        const audit = db.addAuditLog({
          action: 'permissions.restore_backup',
          riskLevel: 'high',
          details: `Restored settings.json from backup ${body.backupId}`,
        });
        broadcast({ type: 'audit:logged', audit });
        sendJson(res, 200, { settings: restored, audit });
        return;
      }

      if (pathname === '/api/permissions/delete-lock' && method === 'GET') {
        const dir = parsedUrl.searchParams.get('path') || defaultWorkspace;
        const status = permissions.checkDirectoryDeleteProtection(dir);
        const commands = PermissionsManager.getDeleteLockCommands(dir);
        sendJson(res, 200, { path: dir, ...status, commands });
        return;
      }

      if (pathname === '/api/permissions/delete-lock' && method === 'POST') {
        const body = await readJsonBody<{
          path?: string;
          enable?: boolean;
          confirmSecurityChange?: boolean;
        }>(req);
        if (!body.confirmSecurityChange) {
          sendJson(res, 400, {
            error: 'confirmSecurityChange: true is required to change OS-level delete protection.',
          });
          return;
        }
        const targetDir = body.path || defaultWorkspace;
        const enable = Boolean(body.enable);
        const result = permissions.setDirectoryDeleteProtection(targetDir, enable);
        const audit = db.addAuditLog({
          action: enable ? 'os.delete_lock.enable' : 'os.delete_lock.disable',
          riskLevel: 'critical',
          details: `${enable ? 'Enabled' : 'Disabled'} OS-level delete protection on ${targetDir} (${result.command})`,
        });
        broadcast({ type: 'audit:logged', audit });
        sendJson(res, 200, { ...result, audit });
        return;
      }

      // Usage & Model Limits API
      if (pathname === '/api/usage' && method === 'GET') {
        const managed = processManager.listSessions().map((s) => ({
          conversationId: s.conversationId || s.id,
          title: s.title,
          workspace: s.workspacePath,
          model: s.model,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          thinkingTokens: s.thinkingTokens,
          cacheReadTokens: s.cacheReadTokens,
          totalTokens: s.totalTokens,
          turnCount: s.turnCount,
          durationSeconds: s.durationSeconds,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          parentConversationId: s.parentSessionId || '',
        }));
        const snapshot = usage.getSnapshot(managed);
        sendJson(res, 200, snapshot);
        return;
      }

      if (pathname === '/api/usage/budgets' && method === 'PUT') {
        const body = await readJsonBody<{ budgets?: ModelBudgetConfig[] }>(req);
        if (!Array.isArray(body.budgets)) {
          sendJson(res, 400, { error: 'budgets array is required.' });
          return;
        }
        const saved = db.saveModelBudgets(body.budgets);
        usage.setBudgets(saved);
        sendJson(res, 200, { budgets: saved });
        return;
      }

      // Multi-Agent Orchestrator & Workflows API
      if (pathname === '/api/workflows' && method === 'GET') {
        sendJson(res, 200, {
          workflows: orchestrator.listWorkflows(),
          templates: BUILTIN_WORKFLOW_TEMPLATES,
        });
        return;
      }

      if (pathname === '/api/workflows' && method === 'POST') {
        const body = await readJsonBody<{
          name?: string;
          description?: string;
          workspacePath?: string;
          projectId?: string | null;
          maxConcurrency?: number;
          tasks?: WorkflowTaskDefinition[];
        }>(req);

        if (!body.name || !Array.isArray(body.tasks) || body.tasks.length === 0) {
          sendJson(res, 400, { error: 'Workflow name and tasks array are required.' });
          return;
        }

        const wf = orchestrator.createAndStartWorkflow({
          name: body.name,
          description: body.description,
          workspacePath: body.workspacePath || defaultWorkspace,
          projectId: body.projectId ?? null,
          maxConcurrency: body.maxConcurrency ?? 2,
          tasks: body.tasks,
        });
        sendJson(res, 201, { workflow: wf });
        return;
      }

      const wfCancelMatch = /^\/api\/workflows\/([^/]+)\/cancel$/.exec(pathname);
      if (wfCancelMatch && method === 'POST') {
        const wfId = decodeURIComponent(wfCancelMatch[1]);
        const wf = orchestrator.cancelWorkflow(wfId);
        sendJson(res, 200, { workflow: wf });
        return;
      }

      // Git & Worktree Management API
      if (pathname === '/api/git/worktrees' && method === 'GET') {
        const repoPath = parsedUrl.searchParams.get('repoPath') || defaultWorkspace;
        const worktrees = gitManager.listWorktrees(repoPath);
        const currentBranch = gitManager.isGitRepo(repoPath)
          ? gitManager.getCurrentBranch(repoPath)
          : null;
        sendJson(res, 200, { repoPath, currentBranch, worktrees });
        return;
      }

      if (pathname === '/api/git/worktrees' && method === 'POST') {
        const body = await readJsonBody<{
          repoPath?: string;
          taskSlug?: string;
          baseBranch?: string;
        }>(req);
        const repoPath = body.repoPath || defaultWorkspace;
        const slug = body.taskSlug || `worktree-${Date.now().toString(36)}`;
        const worktree = gitManager.createWorktree(repoPath, slug, body.baseBranch);
        sendJson(res, 201, { worktree });
        return;
      }

      if (pathname === '/api/git/worktrees' && method === 'DELETE') {
        const body = await readJsonBody<{
          repoPath?: string;
          worktreePath?: string;
          force?: boolean;
        }>(req);
        if (!body.worktreePath) {
          sendJson(res, 400, { error: 'worktreePath is required.' });
          return;
        }
        gitManager.removeWorktree(
          body.repoPath || defaultWorkspace,
          body.worktreePath,
          Boolean(body.force)
        );
        sendJson(res, 200, { removed: true });
        return;
      }

      if (pathname === '/api/git/diff' && method === 'GET') {
        const wtPath = parsedUrl.searchParams.get('worktreePath') || defaultWorkspace;
        const baseBranch = parsedUrl.searchParams.get('baseBranch') || undefined;
        const diff = gitManager.getWorktreeDiff(wtPath, baseBranch);
        sendJson(res, 200, { diff });
        return;
      }

      if (pathname === '/api/git/conflict-check' && method === 'POST') {
        const body = await readJsonBody<{
          repoPath?: string;
          sourceBranch?: string;
          targetBranch?: string;
        }>(req);
        if (!body.sourceBranch) {
          sendJson(res, 400, { error: 'sourceBranch is required.' });
          return;
        }
        const check = gitManager.checkMergeConflicts(
          body.repoPath || defaultWorkspace,
          body.sourceBranch,
          body.targetBranch
        );
        sendJson(res, 200, { conflictCheck: check });
        return;
      }

      if (pathname === '/api/git/integrate' && method === 'POST') {
        const body = await readJsonBody<{
          repoPath?: string;
          worktreePath?: string;
          commitMessage?: string;
        }>(req);
        if (!body.worktreePath) {
          sendJson(res, 400, { error: 'worktreePath is required.' });
          return;
        }
        const result = gitManager.integrateWorktreeBranch(
          body.repoPath || defaultWorkspace,
          body.worktreePath,
          body.commitMessage
        );
        sendJson(res, 200, result);
        return;
      }

      // Unknown /api route
      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: `API endpoint not found: ${method} ${pathname}` });
        return;
      }

      // Serve static frontend files if available
      const staticDir =
        options.staticDir ||
        path.resolve(defaultWorkspace, 'apps', 'web', 'dist');

      if (fs.existsSync(staticDir)) {
        const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const candidatePath = path.resolve(staticDir, relativePath);
        // Prevent path traversal outside staticDir
        if (
          candidatePath.startsWith(path.resolve(staticDir)) &&
          fs.existsSync(candidatePath) &&
          fs.statSync(candidatePath).isFile()
        ) {
          const ext = path.extname(candidatePath).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          });
          fs.createReadStream(candidatePath).pipe(res);
          return;
        }

        // SPA fallback to index.html
        const indexHtml = path.join(staticDir, 'index.html');
        if (fs.existsSync(indexHtml)) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'X-Content-Type-Options': 'nosniff',
          });
          fs.createReadStream(indexHtml).pipe(res);
          return;
        }
      }

      sendJson(res, 200, {
        app: 'AgyClient Backend API',
        message: 'Backend is running. Build apps/web to serve the UI here.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  // WebSocket server on `/ws`
  const wss = new WebSocketServer({ server, path: '/ws' });

  function broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'connected',
        timestamp: new Date().toISOString(),
        sessions: processManager.listSessions(),
        workflows: orchestrator.listWorkflows(),
      })
    );
  });

  processManager.on('session:updated', (session) => {
    broadcast({ type: 'session:updated', session });
  });
  processManager.on('session:log', (log) => {
    broadcast({ type: 'session:log', log });
  });
  orchestrator.on('workflow:updated', (workflow) => {
    broadcast({ type: 'workflow:updated', workflow });
  });

  const close = async (): Promise<void> => {
    processManager.stopAll();
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      if (server.listening) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
    db.close();
  };

  return {
    server,
    wss,
    db,
    adapter,
    permissions,
    usage,
    processManager,
    gitManager,
    orchestrator,
    close,
  };
}
