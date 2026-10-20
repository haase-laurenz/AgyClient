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
import { parseCliArgs, runCli } from '../apps/server/src/cli.js';

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

  describe('P8: Cross-Platform CLI Interface (agyclient / agy-client) & Linux Support', () => {
    it('generates OS-appropriate delete-lock commands for Linux, macOS, and Windows', () => {
      const linuxCmds = PermissionsManager.getDeleteLockCommands('/home/dev/project', 'dev', 'linux');
      expect(linuxCmds.platform).toBe('linux');
      expect(linuxCmds.enableCommand).toContain('chattr +a');
      expect(linuxCmds.checkCommand).toContain('lsattr -d');

      const macCmds = PermissionsManager.getDeleteLockCommands('/Users/dev/project', 'dev', 'darwin');
      expect(macCmds.platform).toBe('darwin');
      expect(macCmds.enableCommand).toContain('deny delete,delete_child');

      const winCmds = PermissionsManager.getDeleteLockCommands('C:\\project', 'dev', 'win32');
      expect(winCmds.platform).toBe('win32');
      expect(winCmds.enableCommand).toContain('icacls');
    });

    it('parses CLI flags and executes doctor, permissions, status, and run subcommands', async () => {
      const parsed = parseCliArgs(['run', 'Inspect repo', '-m', 'gemini-4-argon-high', '--worktree']);
      expect(parsed.command).toBe('run');
      expect(parsed.positionals).toEqual(['Inspect repo']);
      expect(parsed.flags.model).toBe('gemini-4-argon-high');
      expect(parsed.flags.worktree).toBe(true);

      const settingsPath = path.join(tmpDir, 'settings.json');
      const backupDir = path.join(tmpDir, 'backups');
      const dbPath = path.join(tmpDir, 'cli.db');
      const mockAgyScript = path.join(tmpDir, 'mock-cli-agy.mjs');

      fs.writeFileSync(
        mockAgyScript,
        `
        console.log(JSON.stringify({
          event: 'init',
          conversation_id: 'conv-cli-1',
          init: { cwd: process.cwd(), tools: [], permission_mode: 'auto' }
        }));
        console.log(JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conv-cli-1',
            status: 'SUCCESS',
            response: 'CLI run finished',
            duration_seconds: 0.1,
            num_turns: 1,
            usage: { input_tokens: 50, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 60 }
          }
        }));
        process.exit(0);
        `,
        'utf-8'
      );

      const logs: string[] = [];
      const env = {
        cwd: tmpDir,
        agyBin: mockAgyScript,
        appDataDir: tmpDir,
        settingsPath,
        backupDir,
        dbPath,
        stdout: (msg: string) => logs.push(msg),
        stderr: (msg: string) => logs.push(msg),
      };

      // 1. Apply permission preset via CLI
      const presetCode = await runCli(['permissions', 'preset', 'autonomous-safe'], env);
      expect(presetCode).toBe(0);

      // 2. Evaluate a Linux deletion command via CLI
      logs.length = 0;
      const evalCode = await runCli(['permissions', 'eval', 'rm -rf /tmp/data', '--json'], env);
      expect(evalCode).toBe(0);
      const evalJson = JSON.parse(logs.join('\n'));
      expect(evalJson.decision).toBe('deny');

      // 3. Run an agent turn via CLI and verify persistence in status
      logs.length = 0;
      const runCode = await runCli(['run', 'Test CLI agent', '--json'], env);
      expect(runCode).toBe(0);
      const runSession = JSON.parse(logs.join('\n'));
      expect(runSession.status).toBe('completed');
      expect(runSession.totalTokens).toBe(60);

      // 4. Query status via CLI
      logs.length = 0;
      const statusCode = await runCli(['status', '--json'], env);
      expect(statusCode).toBe(0);
      const statusJson = JSON.parse(logs.join('\n'));
      expect(statusJson.sessions.total).toBe(1);
      expect(statusJson.sessions.completed).toBe(1);
    });
  });

  describe('P9: SubAgent Spawning & Hierarchy Management', () => {
    it('extracts <subagent> directives, spawns child SubAgents via API & ProcessManager, and tracks native invoke_subagent hierarchy', async () => {
      const directives = ProcessManager.extractSubagentDirectives(
        `Let's delegate:\n<subagent title="Audit Auth" role="Security Reviewer">Check token validation</subagent>`
      );
      expect(directives).toHaveLength(1);
      expect(directives[0].title).toBe('Audit Auth');
      expect(directives[0].role).toBe('Security Reviewer');
      expect(directives[0].prompt).toBe('Check token validation');

      const mockAgyScript = path.join(tmpDir, 'mock-subagent-agy.mjs');
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
          init: { cwd: process.cwd(), tools: ['invoke_subagent'], permission_mode: 'auto' }
        }));
        if (prompt.includes('USE_NATIVE_SUBAGENT')) {
          console.log(JSON.stringify({
            event: 'step_update',
            step_update: {
              conversation_id: convId,
              step_index: 2,
              state: 'DONE',
              step_type: 'tool_call',
              tool_name: 'invoke_subagent',
              tool_args: { TypeName: 'research', Role: 'Codebase Researcher', Prompt: 'Inspect modules' },
              duration_seconds: 0.4
            }
          }));
        }
        console.log(JSON.stringify({
          event: 'result',
          result: {
            conversation_id: convId,
            status: 'SUCCESS',
            response: 'Completed: ' + prompt,
            duration_seconds: 0.2,
            num_turns: 1,
            usage: { input_tokens: 80, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 100 }
          }
        }));
        process.exit(0);
        `,
        'utf-8'
      );

      const dbPath = path.join(tmpDir, 'subagents.db');
      const settingsPath = path.join(tmpDir, 'settings.json');
      const backupDir = path.join(tmpDir, 'backups');

      const instance = createAgyServer({
        dbPath,
        agyBin: mockAgyScript,
        settingsPath,
        backupDir,
        defaultWorkspacePath: tmpDir,
      });

      await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', () => resolve()));
      const addr = instance.server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // 1. Launch a root parent agent that also invokes a native subagent
      const parentDone = new Promise<void>((resolve) => {
        instance.processManager.once('session:completed', () => resolve());
      });

      const launchRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Root Coordinator Agent',
          workspacePath: tmpDir,
          prompt: 'USE_NATIVE_SUBAGENT: Coordinate complex task',
          allowSubagents: true,
        }),
      });
      expect(launchRes.status).toBe(201);
      const launchData = await launchRes.json();
      const parentId = launchData.session.id;

      await parentDone;

      // 2. Spawn 2 parallel child SubAgents under the parent via POST /api/sessions/:id/subagents
      const subRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(parentId)}/subagents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subagentRole: 'Architect',
          prompts: ['Design database schema', 'Design REST endpoints'],
        }),
      });
      expect(subRes.status).toBe(201);
      const subData = await subRes.json();
      expect(subData.subagents).toHaveLength(2);
      expect(subData.subagents[0].parentSessionId).toBe(parentId);
      expect(subData.subagents[0].executionRole).toBe('subagent');
      expect(subData.subagents[0].subagentRole).toBe('Architect');

      // 3. Verify GET /api/sessions/:id/subagents returns both native + spawned SubAgents (total 3)
      const listSubRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(parentId)}/subagents`);
      const listSubData = await listSubRes.json();
      expect(listSubData.subagents).toHaveLength(3);

      await instance.close();
    });
  });
});
