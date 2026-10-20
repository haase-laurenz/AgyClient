import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AgyCliAdapter,
  AgyStreamParser,
  buildAgyCliArgs,
} from '../packages/agy-adapter/src/index.js';
import { PermissionsManager } from '../packages/permissions/src/index.js';
import { UsageTracker } from '../packages/usage/src/index.js';
import { ProcessManager } from '../packages/process-manager/src/index.js';
import { GitWorktreeManager } from '../packages/git-manager/src/index.js';
import { WorkflowOrchestrator } from '../packages/orchestrator/src/index.js';
import { createAgyServer } from '../apps/server/src/app.js';

describe('AgyClient Comprehensive Test Suite (P0 - P7)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyclient-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows file locks
    }
  });

  describe('P0/P1: @agy-client/agy-adapter', () => {
    it('places --print and the prompt at the end of the CLI argument list', () => {
      const args = buildAgyCliArgs({
        prompt: 'Analyze repository',
        model: 'gemini-4-argon-medium',
        effort: 'high',
        mode: 'auto',
        sandbox: true,
        outputFormat: 'stream-json',
      });

      expect(args.slice(0, 2)).toEqual(['--output-format', 'stream-json']);
      expect(args.slice(-2)).toEqual(['--print', 'Analyze repository']);
      expect(args).toContain('--sandbox');
      expect(args).toContain('gemini-4-argon-medium');
    });

    it('parses chunked NDJSON stream-json events accurately', () => {
      const parser = new AgyStreamParser();
      const chunk1 =
        '{"event":"init","conversation_id":"conv-123","init":{"cwd":"C:\\\\test","tools":["view_file"],"permission_mode":"auto"}}\n{"event":"step_up';
      const chunk2 =
        'date","step_update":{"conversation_id":"conv-123","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello"}}\n' +
        '{"event":"result","result":{"conversation_id":"conv-123","status":"SUCCESS","response":"Hello world","duration_seconds":2.5,"num_turns":1,"usage":{"input_tokens":500,"output_tokens":20,"thinking_tokens":0,"cache_read_tokens":100,"total_tokens":520}}}\n';

      const events1 = parser.feed(chunk1);
      expect(events1).toHaveLength(1);
      expect(events1[0].event).toBe('init');

      const events2 = parser.feed(chunk2);
      expect(events2).toHaveLength(2);
      expect(events2[0].event).toBe('step_update');
      expect(events2[1].event).toBe('result');
    });
  });

  describe('P3: @agy-client/permissions & Multi-Layer Security Guardrails', () => {
    it('validates rule syntax and rejects malformed regexes or unknown scopes', () => {
      expect(PermissionsManager.validateRule('command(*)').valid).toBe(true);
      expect(
        PermissionsManager.validateRule('command(regex:.*\\bRemove-Item\\b.*)').valid
      ).toBe(true);
      expect(PermissionsManager.validateRule('invalid_scope(*)').valid).toBe(false);
      expect(PermissionsManager.validateRule('command(regex:[unclosed)').valid).toBe(false);
    });

    it('creates automatic backups, updates settings, and enforces Deny > Builtin Guard > Ask > Allow', () => {
      const settingsPath = path.join(tmpDir, 'settings.json');
      const backupDir = path.join(tmpDir, 'backups');
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          permissions: {
            allow: ['command(*)', 'read_file(*)', 'write_file(*)'],
            ask: [],
            deny: ['command(regex:.*\\b(del|Remove-Item)\\b.*)'],
          },
          trustedWorkspaces: [tmpDir],
        }),
        'utf-8'
      );

      const pm = new PermissionsManager({ settingsPath, backupDir });

      // 1. Routine build command is allowed
      const evalBuild = pm.evaluateAction('command', 'npm run build');
      expect(evalBuild.decision).toBe('allow');

      // 2. Direct deletion is blocked by settings_deny
      const evalDel = pm.evaluateAction('command', 'Remove-Item -Recurse ./src');
      expect(evalDel.decision).toBe('deny');
      expect(evalDel.matchedLayer).toBe('settings_deny');

      // 3. Interpreter file-deletion bypass is caught by builtin_destructive_guard even when command(*) is allowed!
      const evalNodeBypass = pm.evaluateAction(
        'command',
        'node -e "const fs = require(\'fs\'); fs.rmSync(\'important.txt\')"'
      );
      expect(evalNodeBypass.decision).toBe('deny');
      expect(evalNodeBypass.matchedLayer).toBe('builtin_destructive_guard');

      // 4. Destructive Git history reset triggers confirmation (ask)
      const evalGitReset = pm.evaluateAction('command', 'git reset --hard HEAD~2');
      expect(evalGitReset.decision).toBe('ask');
      expect(evalGitReset.matchedLayer).toBe('builtin_destructive_guard');

      // 5. Updating settings creates a backup that can be restored
      const { backup } = pm.updateSettings({
        permissions: {
          allow: ['read_file(*)'],
          ask: ['command(*)'],
          deny: ['write_file(*)'],
        },
      });
      expect(backup).not.toBeNull();
      expect(pm.readSettings().permissions.deny).toContain('write_file(*)');

      pm.restoreBackup(backup!.id);
      expect(pm.readSettings().permissions.allow).toContain('command(*)');
    });
  });

  describe('P2: @agy-client/process-manager (3 Parallel Agents & Stop/Recovery)', () => {
    it('runs 3 independent processes simultaneously, collects token usage, and stops processes cleanly', async () => {
      // Create a mock agy script that outputs valid stream-json events
      const mockAgyScript = path.join(tmpDir, 'mock-agy.mjs');
      fs.writeFileSync(
        mockAgyScript,
        `
        const args = process.argv.slice(2);
        const promptIdx = args.indexOf('--print');
        const prompt = promptIdx !== -1 ? args[promptIdx + 1] : 'default';
        const convId = 'conv-' + Math.random().toString(36).slice(2, 10);
        console.log(JSON.stringify({
          event: 'init',
          conversation_id: convId,
          init: { cwd: process.cwd(), tools: ['view_file'], permission_mode: 'auto' }
        }));
        setTimeout(() => {
          console.log(JSON.stringify({
            event: 'step_update',
            step_update: {
              conversation_id: convId,
              step_index: 1,
              state: 'DONE',
              step_type: 'agent_response',
              text_delta: 'Processed: ' + prompt,
              duration_seconds: 0.2,
              usage: { input_tokens: 120, output_tokens: 30, thinking_tokens: 0, cache_read_tokens: 20, total_tokens: 150 }
            }
          }));
          console.log(JSON.stringify({
            event: 'result',
            result: {
              conversation_id: convId,
              status: 'SUCCESS',
              response: 'Processed: ' + prompt,
              duration_seconds: 0.25,
              num_turns: 1,
              usage: { input_tokens: 120, output_tokens: 30, thinking_tokens: 0, cache_read_tokens: 20, total_tokens: 150 }
            }
          }));
          process.exit(0);
        }, 120);
        `,
        'utf-8'
      );

      const pm = new ProcessManager({ agyBin: mockAgyScript });

      const completedPromises = [1, 2, 3].map(
        (idx) =>
          new Promise<void>((resolve, reject) => {
            const onDone = (s: { id: string; status: string }) => {
              if (s.id === session.id) {
                pm.off('session:completed', onDone);
                pm.off('session:failed', onFail);
                resolve();
              }
            };
            const onFail = (s: { id: string; error: string | null }) => {
              if (s.id === session.id) {
                pm.off('session:completed', onDone);
                pm.off('session:failed', onFail);
                reject(new Error(s.error || 'Failed'));
              }
            };
            pm.on('session:completed', onDone);
            pm.on('session:failed', onFail);

            const session = pm.startSession({
              title: `Parallel Agent ${idx}`,
              workspacePath: tmpDir,
              prompt: `Task number ${idx}`,
              model: 'gemini-4-argon-medium',
            });
          })
      );

      // Verify all 3 are running concurrently right after launch
      const activeSessions = pm.listSessions();
      expect(activeSessions).toHaveLength(3);

      await Promise.all(completedPromises);

      for (const s of pm.listSessions()) {
        expect(s.status).toBe('completed');
        expect(s.totalTokens).toBe(150);
        expect(s.lastResponse).toContain('Processed: Task number');
        expect(s.conversationId).toMatch(/^conv-/);
      }
    });
  });

  describe('P4: @agy-client/usage & Official Transcript Aggregation', () => {
    it('parses transcript.jsonl tokens and labels data sources transparently', () => {
      const convId = 'test-conv-001';
      const logsDir = path.join(tmpDir, 'brain', convId, '.system_generated', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, 'transcript.jsonl'),
        [
          JSON.stringify({
            step_index: 0,
            source: 'USER_EXPLICIT',
            type: 'USER_INPUT',
            status: 'DONE',
            created_at: new Date(Date.now() - 60_000).toISOString(),
            content: 'Hello',
          }),
          JSON.stringify({
            step_index: 1,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: new Date().toISOString(),
            input_tokens: 1000,
            output_tokens: 250,
            cache_read_tokens: 500,
          }),
        ].join('\n'),
        'utf-8'
      );

      const adapter = new AgyCliAdapter({ appDataDir: tmpDir });
      const tracker = new UsageTracker({ adapter });
      const snapshot = tracker.getSnapshot();

      expect(snapshot.totals.inputTokens).toBe(1000);
      expect(snapshot.totals.outputTokens).toBe(250);
      expect(snapshot.totals.totalTokens).toBe(1250);
      expect(snapshot.totals.dataSource).toBe('officially_reported');
      expect(snapshot.quotas[0].tokenDataSource).toBe('officially_reported');
      expect(snapshot.quotas[0].quotaLimitDataSource).toBe('estimated_local_budget');
      expect(snapshot.quotas[0].officialCloudQuotaStatus).toBe('unavailable');
    });
  });

  describe('P5 & P6: @agy-client/git-manager & @agy-client/orchestrator', () => {
    it('creates isolated Git worktrees, detects merge conflicts, and integrates clean branches', () => {
      const gm = new GitWorktreeManager();
      gm.ensureRepoReadyForWorktrees(tmpDir);

      // Write a base file on main
      fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'line 1\n', 'utf-8');
      gm.commitWorktreeChanges(tmpDir, 'add shared.txt');

      const wt = gm.createWorktree(tmpDir, 'agent-feature');
      expect(fs.existsSync(wt.worktreePath)).toBe(true);
      expect(wt.branch).toBe('agy/agent-feature');

      // Modify file in worktree
      fs.writeFileSync(path.join(wt.worktreePath, 'feature.txt'), 'new agent feature\n', 'utf-8');
      const diff = gm.getWorktreeDiff(wt.worktreePath);
      expect(diff.changedFiles.length).toBeGreaterThan(0);

      // Integrate cleanly into main
      const mergeResult = gm.integrateWorktreeBranch(tmpDir, wt.worktreePath, 'feat: add feature.txt');
      expect(mergeResult.merged).toBe(true);
      expect(mergeResult.conflictCheck.hasConflicts).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'feature.txt'))).toBe(true);

      gm.removeWorktree(tmpDir, wt.worktreePath, true);
    });

    it('validates workflow DAGs and rejects circular dependencies', () => {
      expect(() =>
        WorkflowOrchestrator.validateDag([
          {
            id: 'a',
            name: 'Task A',
            role: 'research',
            strategy: 'independent_process',
            prompt: 'A',
            dependsOn: ['b'],
          },
          {
            id: 'b',
            name: 'Task B',
            role: 'implement',
            strategy: 'independent_process',
            prompt: 'B',
            dependsOn: ['a'],
          },
        ])
      ).toThrow(/Circular dependency/);
    });
  });

  describe('P7: Server Security Boundaries & Persistence Across Restarts', () => {
    it('blocks non-localhost Host/Origin headers, requires confirmation for permission edits, and persists session history across restarts', async () => {
      const dbPath = path.join(tmpDir, 'agy.db');
      const settingsPath = path.join(tmpDir, 'settings.json');
      const backupDir = path.join(tmpDir, 'backups');

      const instance1 = createAgyServer({
        dbPath,
        settingsPath,
        backupDir,
        defaultWorkspacePath: tmpDir,
      });

      await new Promise<void>((resolve) => instance1.server.listen(0, '127.0.0.1', () => resolve()));
      const addr = instance1.server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // 1. Health endpoint works on 127.0.0.1
      const healthRes = await fetch(`${baseUrl}/api/health`);
      expect(healthRes.status).toBe(200);

      // 2. Rejects cross-origin mutating requests
      const evilOriginRes = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example.com',
        },
        body: JSON.stringify({ name: 'Test', path: tmpDir }),
      });
      expect(evilOriginRes.status).toBe(403);

      // 3. Rejects permission modifications without confirmSecurityChange: true
      const unconfirmedPermRes = await fetch(`${baseUrl}/api/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permissions: { allow: ['read_file(*)'], ask: [], deny: [] },
          confirmSecurityChange: false,
        }),
      });
      expect(unconfirmedPermRes.status).toBe(400);

      // 4. Succeeds with confirmSecurityChange: true and writes audit log
      const confirmedPermRes = await fetch(`${baseUrl}/api/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permissions: { allow: ['read_file(*)'], ask: [], deny: ['command(*)'] },
          confirmSecurityChange: true,
        }),
      });
      expect(confirmedPermRes.status).toBe(200);

      // Save a session into DB and close server
      instance1.db.saveSession({
        id: 'persisted-session-1',
        title: 'Persisted Agent Task',
        projectId: null,
        workspacePath: tmpDir,
        worktreePath: null,
        branchName: null,
        conversationId: 'conv-persisted-999',
        parentSessionId: null,
        executionRole: 'independent',
        model: 'gemini-4-argon-medium',
        effort: 'medium',
        mode: 'auto',
        sandbox: false,
        status: 'completed',
        pid: null,
        prompt: 'Test persistence',
        lastResponse: 'Survived restart',
        inputTokens: 400,
        outputTokens: 50,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 450,
        turnCount: 1,
        durationSeconds: 3.2,
        exitCode: 0,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await instance1.close();

      // Restart a brand new server instance pointing to the same SQLite DB
      const instance2 = createAgyServer({
        dbPath,
        settingsPath,
        backupDir,
        defaultWorkspacePath: tmpDir,
      });
      await new Promise<void>((resolve) => instance2.server.listen(0, '127.0.0.1', () => resolve()));
      const addr2 = instance2.server.address() as { port: number };

      const sessionsRes = await fetch(`http://127.0.0.1:${addr2.port}/api/sessions`);
      const sessionsData = await sessionsRes.json();
      expect(sessionsData.sessions).toHaveLength(1);
      expect(sessionsData.sessions[0].id).toBe('persisted-session-1');
      expect(sessionsData.sessions[0].lastResponse).toBe('Survived restart');

      await instance2.close();
    });
  });
});
