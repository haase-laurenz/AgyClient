#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AgyCliAdapter,
  AgyExecutionMode,
  AgyReasoningEffort,
  getDefaultAgyAppDataDir,
} from '@agy-client/agy-adapter';
import {
  PERMISSION_PRESETS,
  PermissionScope,
  PermissionsManager,
} from '@agy-client/permissions';
import { UsageTracker } from '@agy-client/usage';
import { ProcessManager } from '@agy-client/process-manager';
import { GitWorktreeManager } from '@agy-client/git-manager';
import { createAgyServer } from './app.js';
import { AgyDatabase } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_VERSION = '1.0.0';

export interface CliEnvironment {
  cwd?: string;
  agyBin?: string;
  appDataDir?: string;
  settingsPath?: string;
  backupDir?: string;
  dbPath?: string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

interface ParsedCliArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const short = arg.slice(1);
      const next = argv[i + 1];
      if (short === 'p' && next && !next.startsWith('-')) {
        flags.port = next;
        i++;
      } else if (short === 'H' && next && !next.startsWith('-')) {
        flags.host = next;
        i++;
      } else if (short === 'w' && next && !next.startsWith('-')) {
        flags.workspace = next;
        i++;
      } else if (short === 'm' && next && !next.startsWith('-')) {
        flags.model = next;
        i++;
      } else if (short === 'e' && next && !next.startsWith('-')) {
        flags.effort = next;
        i++;
      } else if (short === 'h') {
        flags.help = true;
      } else if (short === 'v') {
        flags.version = true;
      } else {
        flags[short] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  const command = positionals.shift() || 'start';
  return { command, positionals, flags };
}

function getHelpText(): string {
  return `
AgyClient v${CLI_VERSION} — Cross-Platform Control Center & CLI for Google Antigravity (agy)

Usage:
  agyclient [command] [options]
  agy-client [command] [options]

Commands:
  start                        Start the local AgyClient Web Control Center & API server (default)
  doctor                       Run system diagnostics (Node.js, Git, agy CLI, SQLite, OS security)
  status                       Show workspace status, active agents, permissions & token summary
  run "<prompt>"               Launch a managed agy agent session directly in the terminal
  sessions                     List managed agent sessions and native agy conversations
  usage                        Display official token usage and rolling-window model budgets
  permissions [subcommand]     Inspect rules, apply a preset, evaluate a command, or manage delete locks
    permissions status           Show current Allow / Ask / Deny rules & presets
    permissions preset <id>      Apply preset: autonomous-safe | balanced-developer | read-only-research
    permissions eval "<cmd>"     Evaluate a command against multi-layer security guardrails
    permissions lock             Inspect or toggle OS-level directory delete protection
  worktrees [subcommand]       Manage isolated Git worktrees for parallel agents
    worktrees list               List Git worktrees in the current workspace
    worktrees create <slug>      Create an isolated worktree (.worktrees/<slug>)
    worktrees diff [path]        Show uncommitted/branch diff for a worktree
    worktrees integrate <path>   Conflict-check and merge a worktree branch into the main branch
  help                         Show this help message

Global & Server Options:
  -p, --port <number>          Port for the web control center (default: 3000)
  -H, --host <address>         Bind address (default: 127.0.0.1)
  -w, --workspace <path>       Target project workspace directory (default: current directory)
  --token <secret>             Require X-Agy-Token header for API requests
  --open                       Automatically open the Web UI in your default browser

Agent Run Options (agyclient run "<prompt>"):
  -m, --model <id>             Model ID (default: gemini-4-argon-medium)
  -e, --effort <level>         Reasoning effort: low | medium | high | xhigh | max (default: medium)
  --mode <mode>                Execution mode: auto | accept-edits | plan (default: auto)
  --worktree                   Run the agent inside an isolated Git worktree (.worktrees/<slug>)
  --sandbox                    Run agy with --sandbox enabled
  --timeout <seconds>          Maximum turn duration in seconds

General Options:
  --json                       Format output as JSON (supported by doctor, status, sessions, usage)
  -v, --version                Print AgyClient version
  -h, --help                   Print this help guide
`.trim();
}

function openBrowserCrossPlatform(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Ignore browser launch errors on headless Linux servers
  }
}

export async function runCli(argv: string[], env: CliEnvironment = {}): Promise<number> {
  const out = env.stdout ?? ((msg: string) => console.log(msg));
  const errOut = env.stderr ?? ((msg: string) => console.error(msg));
  const parsed = parseCliArgs(argv);

  if (parsed.flags.version) {
    out(`agyclient v${CLI_VERSION}`);
    return 0;
  }

  if (parsed.flags.help || parsed.command === 'help') {
    out(getHelpText());
    return 0;
  }

  const workspacePath = path.resolve(
    typeof parsed.flags.workspace === 'string'
      ? parsed.flags.workspace
      : env.cwd || process.cwd()
  );
  const agyBin =
    typeof parsed.flags['agy-bin'] === 'string'
      ? parsed.flags['agy-bin']
      : env.agyBin || process.env.AGY_BIN || 'agy';
  const appDataDir = env.appDataDir || getDefaultAgyAppDataDir();
  const settingsPath = env.settingsPath || path.join(appDataDir, 'settings.json');
  const backupDir = env.backupDir || path.join(appDataDir, 'backups-agyclient');
  const dbPath = env.dbPath || path.join(workspacePath, '.agy-client', 'agyclient.db');
  const asJson = Boolean(parsed.flags.json);

  // ---------------------------------------------------------------------------
  // COMMAND: doctor
  // ---------------------------------------------------------------------------
  if (parsed.command === 'doctor') {
    const adapter = new AgyCliAdapter({ appDataDir, agyBin });
    const agyVer = adapter.getVersion();
    const gitRes = spawnSync('git', ['--version'], { encoding: 'utf-8', windowsHide: true, timeout: 5000 });
    const gitInstalled = gitRes.status === 0;
    const gitVersion = (gitRes.stdout || '').trim() || null;
    const webBuilt = fs.existsSync(path.join(INSTALL_ROOT, 'apps', 'web', 'dist', 'index.html'));
    const deleteLockInfo = PermissionsManager.getDeleteLockCommands(workspacePath);

    const nodeVersion = process.versions.node;
    const [major, minor] = nodeVersion.split('.').map(Number);
    const nodeSupported = major > 22 || (major === 22 && minor >= 5);

    const report = {
      cliVersion: CLI_VERSION,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      node: {
        version: nodeVersion,
        supported: nodeSupported,
      },
      git: {
        installed: gitInstalled,
        version: gitVersion,
      },
      agyCli: {
        binary: agyBin,
        installed: agyVer.installed,
        version: agyVer.version,
        error: agyVer.error ?? null,
      },
      paths: {
        installRoot: INSTALL_ROOT,
        workspacePath,
        appDataDir,
        settingsPath,
        settingsExists: fs.existsSync(settingsPath),
        webDashboardBuilt: webBuilt,
      },
      osDeleteProtection: deleteLockInfo,
    };

    if (asJson) {
      out(JSON.stringify(report, null, 2));
      return 0;
    }

    out(`========================================================`);
    out(`  AgyClient v${CLI_VERSION} — Environment Doctor`);
    out(`========================================================`);
    out(`  OS Platform      : ${report.platform} (${report.arch}) — ${report.osRelease}`);
    out(`  Node.js Runtime  : v${report.node.version} ${report.node.supported ? '[OK >= 22.5]' : '[WARN: < 22.5]'}`);
    out(`  Git CLI          : ${report.git.installed ? `[OK] ${report.git.version}` : '[MISSING]'}`);
    out(
      `  Antigravity (agy): ${
        report.agyCli.installed
          ? `[OK] ${report.agyCli.version}`
          : `[NOT FOUND IN PATH] (${report.agyCli.binary})`
      }`
    );
    out(`  Agy AppData Dir  : ${report.paths.appDataDir}`);
    out(`  Settings File    : ${report.paths.settingsPath} (${report.paths.settingsExists ? 'present' : 'default'})`);
    out(`  Web UI Bundle    : ${report.paths.webDashboardBuilt ? '[OK] Built' : '[WARN] Run npm run build'}`);
    out(`  OS Delete Lock   : ${report.osDeleteProtection.mechanism}`);
    out(`    Enable cmd     : ${report.osDeleteProtection.enableCommand}`);
    out(`    Disable cmd    : ${report.osDeleteProtection.disableCommand}`);
    out(`========================================================`);
    return 0;
  }

  // ---------------------------------------------------------------------------
  // COMMAND: status
  // ---------------------------------------------------------------------------
  if (parsed.command === 'status') {
    const adapter = new AgyCliAdapter({ appDataDir, agyBin });
    const permissions = new PermissionsManager({ settingsPath, backupDir });
    const db = new AgyDatabase(dbPath);
    try {
      const sessions = db.loadSessions();
      const activeSessions = sessions.filter((s) => s.status === 'running' || s.status === 'starting');
      const settings = permissions.readSettings();
      const tracker = new UsageTracker({ adapter, budgets: db.loadModelBudgets() });
      const usageSnap = tracker.getSnapshot(
        sessions.map((s) => ({
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
        }))
      );
      const agyVer = adapter.getVersion();

      const statusPayload = {
        workspacePath,
        agyCli: agyVer,
        sessions: {
          total: sessions.length,
          active: activeSessions.length,
          completed: sessions.filter((s) => s.status === 'completed').length,
          failed: sessions.filter((s) => s.status === 'failed').length,
        },
        permissions: {
          allowRules: settings.permissions.allow.length,
          askRules: settings.permissions.ask.length,
          denyRules: settings.permissions.deny.length,
          trustedWorkspaces: settings.trustedWorkspaces.length,
        },
        usage: usageSnap.totals,
      };

      if (asJson) {
        out(JSON.stringify(statusPayload, null, 2));
        return 0;
      }

      out(`AgyClient Status — Workspace: ${workspacePath}`);
      out(`  Antigravity CLI  : ${agyVer.installed ? agyVer.version : `Not detected (${agyBin})`}`);
      out(
        `  Managed Sessions : ${statusPayload.sessions.total} total (${statusPayload.sessions.active} active, ${statusPayload.sessions.completed} completed, ${statusPayload.sessions.failed} failed)`
      );
      out(
        `  Permission Rules : ${statusPayload.permissions.allowRules} Allow | ${statusPayload.permissions.askRules} Ask | ${statusPayload.permissions.denyRules} Deny`
      );
      out(
        `  Official Usage   : ${statusPayload.usage.totalTokens.toLocaleString()} tokens across ${statusPayload.usage.totalRequests} requests (${statusPayload.usage.totalDurationSeconds.toFixed(1)}s)`
      );
      return 0;
    } finally {
      db.close();
    }
  }

  // ---------------------------------------------------------------------------
  // COMMAND: sessions
  // ---------------------------------------------------------------------------
  if (parsed.command === 'sessions') {
    const adapter = new AgyCliAdapter({ appDataDir, agyBin });
    const db = new AgyDatabase(dbPath);
    try {
      const managed = db.loadSessions();
      const cliConversations = adapter.listCliConversations(30);
      if (asJson) {
        out(JSON.stringify({ sessions: managed, cliConversations }, null, 2));
        return 0;
      }

      out(`Managed Agent Sessions (${managed.length}):`);
      if (managed.length === 0) {
        out(`  (No managed sessions recorded yet in ${dbPath})`);
      } else {
        for (const s of managed.slice(0, 25)) {
          out(
            `  - [${s.status.toUpperCase().padEnd(9)}] ${s.id.slice(0, 8)} | ${s.model.padEnd(23)} | ${s.totalTokens
              .toLocaleString()
              .padStart(8)} tok | ${s.title}`
          );
        }
      }

      if (cliConversations.length > 0) {
        out(`\nRecent Native agy CLI Conversations (${cliConversations.length}):`);
        for (const c of cliConversations.slice(0, 10)) {
          out(
            `  - ${c.conversationId.slice(0, 8)} | steps: ${String(c.stepCount).padStart(3)} | ${
              c.title || c.preview.slice(0, 50) || '(Untitled)'
            }`
          );
        }
      }
      return 0;
    } finally {
      db.close();
    }
  }

  // ---------------------------------------------------------------------------
  // COMMAND: usage
  // ---------------------------------------------------------------------------
  if (parsed.command === 'usage') {
    const adapter = new AgyCliAdapter({ appDataDir, agyBin });
    const db = new AgyDatabase(dbPath);
    try {
      const sessions = db.loadSessions();
      const tracker = new UsageTracker({ adapter, budgets: db.loadModelBudgets() });
      const snapshot = tracker.getSnapshot(
        sessions.map((s) => ({
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
        }))
      );

      if (asJson) {
        out(JSON.stringify(snapshot, null, 2));
        return 0;
      }

      out(`========================================================`);
      out(`  AgyClient Token Usage & Rolling-Window Quotas`);
      out(`========================================================`);
      out(`  Total Tokens     : ${snapshot.totals.totalTokens.toLocaleString()} (${snapshot.totals.dataSource})`);
      out(`    Input Tokens   : ${snapshot.totals.inputTokens.toLocaleString()}`);
      out(`    Output Tokens  : ${snapshot.totals.outputTokens.toLocaleString()}`);
      out(`    Cache Read     : ${snapshot.totals.cacheReadTokens.toLocaleString()}`);
      out(`  Total Requests   : ${snapshot.totals.totalRequests}`);
      out(`  Total Duration   : ${snapshot.totals.totalDurationSeconds.toFixed(1)}s`);
      out(`\n  Model Family Rolling Budgets:`);
      for (const q of snapshot.quotas) {
        const usedPct = Math.max(0, Math.round((100 - q.remainingTokenPercent) * 10) / 10);
        out(
          `    - ${q.family.padEnd(14)} : ${q.usedTokens.toLocaleString()} / ${q.maxTokens.toLocaleString()} tokens (${usedPct}% used, ${q.remainingTokenPercent}% rem in ${q.windowHours}h window)`
        );
      }
      return 0;
    } finally {
      db.close();
    }
  }

  // ---------------------------------------------------------------------------
  // COMMAND: permissions
  // ---------------------------------------------------------------------------
  if (parsed.command === 'permissions') {
    const sub = parsed.positionals[0] || 'status';
    const pm = new PermissionsManager({ settingsPath, backupDir });

    if (sub === 'status') {
      const settings = pm.readSettings();
      if (asJson) {
        out(JSON.stringify({ settingsPath: pm.getSettingsPath(), settings, presets: PERMISSION_PRESETS }, null, 2));
        return 0;
      }
      out(`Permissions File: ${pm.getSettingsPath()}`);
      out(`  Allow Rules (${settings.permissions.allow.length}):`);
      for (const r of settings.permissions.allow) out(`    + ${r}`);
      out(`  Ask Rules (${settings.permissions.ask.length}):`);
      for (const r of settings.permissions.ask) out(`    ? ${r}`);
      out(`  Deny Rules (${settings.permissions.deny.length}):`);
      for (const r of settings.permissions.deny) out(`    - ${r}`);
      out(`\nAvailable Presets (apply with: agyclient permissions preset <id>):`);
      for (const preset of PERMISSION_PRESETS) {
        out(`  * ${preset.id.padEnd(20)} — ${preset.name}`);
      }
      return 0;
    }

    if (sub === 'preset') {
      const presetId = parsed.positionals[1];
      const preset = PERMISSION_PRESETS.find((p) => p.id === presetId);
      if (!preset) {
        errOut(
          `Unknown preset "${presetId || ''}". Available presets: ${PERMISSION_PRESETS.map((p) => p.id).join(', ')}`
        );
        return 1;
      }
      const { settings, backup } = pm.updateSettings({
        permissions: preset.permissions,
      });
      if (asJson) {
        out(JSON.stringify({ appliedPreset: preset.id, settings, backup }, null, 2));
        return 0;
      }
      out(`Applied permission preset "${preset.name}" (${preset.id}).`);
      if (backup) {
        out(`Created backup: ${backup.path}`);
      }
      return 0;
    }

    if (sub === 'eval') {
      const target = parsed.positionals.slice(1).join(' ').trim();
      if (!target) {
        errOut(`Usage: agyclient permissions eval "<command>" [--scope command]`);
        return 1;
      }
      const scope = (typeof parsed.flags.scope === 'string' ? parsed.flags.scope : 'command') as PermissionScope;
      const evaluation = pm.evaluateAction(scope, target);
      if (asJson) {
        out(JSON.stringify(evaluation, null, 2));
        return 0;
      }
      out(`Decision   : ${evaluation.decision.toUpperCase()}`);
      out(`Risk Level : ${evaluation.riskLevel.toUpperCase()}`);
      out(`Layer      : ${evaluation.matchedLayer}${evaluation.matchedRule ? ` (${evaluation.matchedRule})` : ''}`);
      out(`Reason     : ${evaluation.reason}`);
      return 0;
    }

    if (sub === 'lock') {
      const targetDir =
        typeof parsed.flags.path === 'string' ? path.resolve(parsed.flags.path) : workspacePath;
      if (parsed.flags.enable || parsed.flags.disable) {
        const enable = Boolean(parsed.flags.enable);
        const res = pm.setDirectoryDeleteProtection(targetDir, enable);
        if (asJson) {
          out(JSON.stringify(res, null, 2));
          return res.success ? 0 : 1;
        }
        out(`${res.success ? '[OK]' : '[WARN]'} ${res.command}`);
        if (res.output) out(res.output);
        return res.success ? 0 : 1;
      }

      const status = pm.checkDirectoryDeleteProtection(targetDir);
      const cmds = PermissionsManager.getDeleteLockCommands(targetDir);
      if (asJson) {
        out(JSON.stringify({ path: targetDir, ...status, commands: cmds }, null, 2));
        return 0;
      }
      out(`Directory  : ${targetDir}`);
      out(`Mechanism  : ${cmds.mechanism}`);
      out(`Protected  : ${status.protected ? 'YES' : 'NO'}`);
      out(`Enable Cmd : ${cmds.enableCommand}`);
      out(`Disable Cmd: ${cmds.disableCommand}`);
      return 0;
    }

    errOut(`Unknown permissions subcommand "${sub}". Use status, preset, eval, or lock.`);
    return 1;
  }

  // ---------------------------------------------------------------------------
  // COMMAND: worktrees
  // ---------------------------------------------------------------------------
  if (parsed.command === 'worktrees') {
    const sub = parsed.positionals[0] || 'list';
    const gm = new GitWorktreeManager();

    if (sub === 'list') {
      const worktrees = gm.listWorktrees(workspacePath);
      if (asJson) {
        out(JSON.stringify({ workspacePath, worktrees }, null, 2));
        return 0;
      }
      out(`Git Worktrees in ${workspacePath} (${worktrees.length}):`);
      for (const wt of worktrees) {
        out(
          `  - ${wt.branch.padEnd(25)} | ${wt.head} | ${wt.changedFilesCount} changed | ${wt.worktreePath}${
            wt.isMain ? ' (main)' : ''
          }`
        );
      }
      return 0;
    }

    if (sub === 'create') {
      const slug = parsed.positionals[1] || `agent-${Date.now().toString(36)}`;
      const wt = gm.createWorktree(workspacePath, slug);
      if (asJson) {
        out(JSON.stringify(wt, null, 2));
        return 0;
      }
      out(`Created isolated Git worktree:`);
      out(`  Path  : ${wt.worktreePath}`);
      out(`  Branch: ${wt.branch}`);
      return 0;
    }

    if (sub === 'diff') {
      const targetPath = parsed.positionals[1] ? path.resolve(parsed.positionals[1]) : workspacePath;
      const diff = gm.getWorktreeDiff(targetPath);
      if (asJson) {
        out(JSON.stringify(diff, null, 2));
        return 0;
      }
      out(`Diff for ${diff.worktreePath} (branch ${diff.branch}):`);
      out(diff.diffStat || '(No uncommitted changes)');
      return 0;
    }

    if (sub === 'integrate') {
      const wtPath = parsed.positionals[1];
      if (!wtPath) {
        errOut(`Usage: agyclient worktrees integrate <worktree-path>`);
        return 1;
      }
      const res = gm.integrateWorktreeBranch(workspacePath, path.resolve(wtPath));
      if (asJson) {
        out(JSON.stringify(res, null, 2));
        return res.merged ? 0 : 1;
      }
      out(`Integration ${res.merged ? 'SUCCEEDED' : 'BLOCKED BY CONFLICTS'} for branch ${res.branch}`);
      out(res.output);
      return res.merged ? 0 : 1;
    }

    errOut(`Unknown worktrees subcommand "${sub}". Use list, create, diff, or integrate.`);
    return 1;
  }

  // ---------------------------------------------------------------------------
  // COMMAND: run "<prompt>"
  // ---------------------------------------------------------------------------
  if (parsed.command === 'run') {
    const prompt = parsed.positionals.join(' ').trim();
    if (!prompt) {
      errOut(`Usage: agyclient run "<prompt>" [--model <id>] [--effort <level>] [--worktree]`);
      return 1;
    }

    const db = new AgyDatabase(dbPath);
    const gm = new GitWorktreeManager();
    const pm = new ProcessManager({
      agyBin,
      hooks: {
        onSessionSave: (s) => db.saveSession(s),
        onLogAppend: (l) => db.appendLog(l),
      },
    });

    let worktreePath: string | null = null;
    let branchName: string | null = null;
    if (parsed.flags.worktree) {
      const slug = `cli-${Date.now().toString(36)}`;
      const wt = gm.createWorktree(workspacePath, slug);
      worktreePath = wt.worktreePath;
      branchName = wt.branch;
      if (!asJson) {
        out(`[Worktree] Isolated agent in ${worktreePath} (branch ${branchName})`);
      }
    }

    const model = typeof parsed.flags.model === 'string' ? parsed.flags.model : 'gemini-4-argon-medium';
    const effort = (typeof parsed.flags.effort === 'string' ? parsed.flags.effort : 'medium') as AgyReasoningEffort;
    const mode = (typeof parsed.flags.mode === 'string' ? parsed.flags.mode : 'auto') as AgyExecutionMode;
    const timeoutSeconds =
      typeof parsed.flags.timeout === 'string' ? Number(parsed.flags.timeout) : undefined;

    return new Promise<number>((resolve) => {
      pm.on('session:log', (entry) => {
        if (!asJson && (entry.stream === 'agent' || entry.stream === 'tool' || entry.stream === 'stderr')) {
          out(`[${entry.stream}] ${entry.text}`);
        }
      });

      const finish = (session: { status: string; lastResponse: string; totalTokens: number; error: string | null }, code: number) => {
        if (asJson) {
          out(JSON.stringify(session, null, 2));
        } else if (code === 0) {
          out(`\n[Completed] Total tokens: ${session.totalTokens.toLocaleString()}`);
        } else {
          errOut(`\n[Failed] ${session.error || 'Agent exited with non-zero status'}`);
        }
        db.close();
        resolve(code);
      };

      pm.once('session:completed', (s) => finish(s, 0));
      pm.once('session:failed', (s) => finish(s, 1));
      pm.once('session:stopped', (s) => finish(s, 130));

      pm.startSession({
        workspacePath,
        worktreePath,
        branchName,
        prompt,
        model,
        effort,
        mode,
        sandbox: Boolean(parsed.flags.sandbox),
        timeoutSeconds,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // COMMAND: start (default)
  // ---------------------------------------------------------------------------
  if (parsed.command === 'start') {
    const host =
      typeof parsed.flags.host === 'string'
        ? parsed.flags.host
        : process.env.AGYCLIENT_HOST || '127.0.0.1';
    const initialPort = Number(
      typeof parsed.flags.port === 'string'
        ? parsed.flags.port
        : process.env.AGYCLIENT_PORT || 3000
    );
    const apiToken =
      typeof parsed.flags.token === 'string'
        ? parsed.flags.token
        : process.env.AGYCLIENT_TOKEN;

    const instance = createAgyServer({
      defaultWorkspacePath: workspacePath,
      staticDir: path.join(INSTALL_ROOT, 'apps', 'web', 'dist'),
      agyBin,
      appDataDir,
      settingsPath,
      backupDir,
      dbPath,
      apiToken,
    });

    instance.wss.on('error', () => {
      // Handled by instance.server error listener
    });

    await new Promise<void>((resolve, reject) => {
      const tryListen = (port: number, retriesLeft: number) => {
        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
            errOut(`Port ${port} is in use on ${host}, trying port ${port + 1}...`);
            instance.server.removeListener('error', onError);
            tryListen(port + 1, retriesLeft - 1);
            return;
          }
          reject(err);
        };

        instance.server.once('error', onError);
        instance.server.listen(port, host, () => {
          instance.server.removeListener('error', onError);
          const url = `http://${host}:${port}`;
          out(`========================================================`);
          out(`  AgyClient Control Center running at ${url}`);
          out(`  WebSocket live stream bound to ws://${host}:${port}/ws`);
          out(`  Active Workspace : ${workspacePath}`);
          out(`========================================================`);
          if (parsed.flags.open) {
            openBrowserCrossPlatform(url);
          }
          resolve();
        });
      };

      tryListen(initialPort, 10);
    });

    const shutdown = async () => {
      out('\nShutting down AgyClient server and active agent processes...');
      await instance.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep server running until terminated
    return new Promise<number>(() => {});
  }

  errOut(`Unknown command "${parsed.command}". Run "agyclient --help" for usage.`);
  return 1;
}

// Execute automatically when invoked directly as a CLI binary
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentFilePath = path.resolve(fileURLToPath(import.meta.url));
if (
  invokedPath === currentFilePath ||
  invokedPath.endsWith('agyclient') ||
  invokedPath.endsWith('agy-client') ||
  invokedPath.endsWith('cli.js')
) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err) => {
      console.error('Fatal CLI error:', err);
      process.exit(1);
    }
  );
}
