import { EventEmitter } from 'node:events';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  AgyExecutionMode,
  AgyReasoningEffort,
  AgyStreamEvent,
  AgyStreamParser,
  buildAgyCliArgs,
} from '@agy-client/agy-adapter';

export type AgentSessionStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'completed'
  | 'stopped'
  | 'failed';

export interface AgentLogEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'system' | 'agent' | 'tool';
  text: string;
  rawEvent?: AgyStreamEvent;
}

export interface ManagedAgentSession {
  id: string;
  title: string;
  projectId: string | null;
  workspacePath: string;
  worktreePath: string | null;
  branchName: string | null;
  conversationId: string | null;
  parentSessionId: string | null;
  executionRole: 'independent' | 'subagent' | 'workflow-task';
  model: string;
  effort: AgyReasoningEffort;
  mode: AgyExecutionMode;
  sandbox: boolean;
  status: AgentSessionStatus;
  pid: number | null;
  prompt: string;
  lastResponse: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  turnCount: number;
  durationSeconds: number;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartSessionRequest {
  id?: string;
  title?: string;
  projectId?: string | null;
  workspacePath: string;
  worktreePath?: string | null;
  branchName?: string | null;
  conversationId?: string | null;
  parentSessionId?: string | null;
  executionRole?: 'independent' | 'subagent' | 'workflow-task';
  prompt: string;
  model?: string;
  effort?: AgyReasoningEffort;
  mode?: AgyExecutionMode;
  sandbox?: boolean;
  timeoutSeconds?: number;
}

export interface ProcessManagerPersistenceHooks {
  onSessionSave?: (session: ManagedAgentSession) => void;
  onLogAppend?: (entry: AgentLogEntry) => void;
}

export class ProcessManager extends EventEmitter {
  private readonly agyBin: string;
  private readonly sessions = new Map<string, ManagedAgentSession>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly logs = new Map<string, AgentLogEntry[]>();
  private readonly hooks: ProcessManagerPersistenceHooks;
  private readonly maxLogsPerSession: number;

  constructor(options?: {
    agyBin?: string;
    hooks?: ProcessManagerPersistenceHooks;
    maxLogsPerSession?: number;
    initialSessions?: ManagedAgentSession[];
  }) {
    super();
    this.agyBin = options?.agyBin ?? 'agy';
    this.hooks = options?.hooks ?? {};
    this.maxLogsPerSession = options?.maxLogsPerSession ?? 1000;

    if (options?.initialSessions) {
      for (const s of options.initialSessions) {
        // Any session that was still 'running' or 'starting' when the backend last shut down
        // is marked 'stopped' upon recovery unless its process is somehow re-attached.
        const recoveredStatus: AgentSessionStatus =
          s.status === 'running' || s.status === 'starting' ? 'stopped' : s.status;
        const recovered: ManagedAgentSession = {
          ...s,
          status: recoveredStatus,
          pid: null,
        };
        this.sessions.set(recovered.id, recovered);
        if (recoveredStatus !== s.status) {
          this.hooks.onSessionSave?.(recovered);
        }
      }
    }
  }

  public listSessions(): ManagedAgentSession[] {
    return Array.from(this.sessions.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  public getSession(sessionId: string): ManagedAgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  public getSessionLogs(sessionId: string): AgentLogEntry[] {
    return this.logs.get(sessionId) ?? [];
  }

  public hydrateSessionLogs(sessionId: string, entries: AgentLogEntry[]): void {
    this.logs.set(sessionId, entries.slice(-this.maxLogsPerSession));
  }

  /**
   * Starts a new independent `agy` CLI process and streams its NDJSON events in real time.
   */
  public startSession(req: StartSessionRequest): ManagedAgentSession {
    const id = req.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const effectiveCwd = req.worktreePath || req.workspacePath;

    if (!fs.existsSync(effectiveCwd)) {
      throw new Error(`Workspace directory does not exist: ${effectiveCwd}`);
    }

    const session: ManagedAgentSession = {
      id,
      title: req.title?.trim() || req.prompt.trim().slice(0, 65) || `Agent ${id.slice(0, 8)}`,
      projectId: req.projectId ?? null,
      workspacePath: req.workspacePath,
      worktreePath: req.worktreePath ?? null,
      branchName: req.branchName ?? null,
      conversationId: req.conversationId ?? null,
      parentSessionId: req.parentSessionId ?? null,
      executionRole: req.executionRole ?? 'independent',
      model: req.model || 'gemini-4-argon-medium',
      effort: req.effort || 'medium',
      mode: req.mode || 'auto',
      sandbox: Boolean(req.sandbox),
      status: 'starting',
      pid: null,
      prompt: req.prompt,
      lastResponse: '',
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      turnCount: 0,
      durationSeconds: 0,
      exitCode: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(id, session);
    this.logs.set(id, []);
    this.persistAndEmit(session);

    this.spawnAgyTurn(session, req.prompt, req.timeoutSeconds);
    return session;
  }

  /**
   * Sends a follow-up prompt to an existing session by resuming its `conversationId` with `agy --conversation <id>`.
   */
  public sendFollowUpPrompt(
    sessionId: string,
    prompt: string,
    timeoutSeconds?: number
  ): ManagedAgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }
    if (this.processes.has(sessionId)) {
      throw new Error(`Session "${sessionId}" is currently running a turn.`);
    }

    session.prompt = prompt;
    session.status = 'starting';
    session.error = null;
    session.updatedAt = new Date().toISOString();
    this.persistAndEmit(session);

    this.spawnAgyTurn(session, prompt, timeoutSeconds);
    return session;
  }

  private spawnAgyTurn(
    session: ManagedAgentSession,
    prompt: string,
    timeoutSeconds?: number
  ): void {
    const effectiveCwd = session.worktreePath || session.workspacePath;
    const args = buildAgyCliArgs({
      prompt,
      model: session.model,
      effort: session.effort,
      mode: session.mode,
      sandbox: session.sandbox,
      conversationId: session.conversationId ?? undefined,
      outputFormat: 'stream-json',
      printTimeoutSeconds: timeoutSeconds,
    });

    this.appendLog(session.id, 'system', `Launching: ${this.agyBin} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

    const startedAtMs = Date.now();
    let child: ChildProcess;

    try {
      const lowerBin = this.agyBin.toLowerCase();
      if (lowerBin.endsWith('.mjs') || lowerBin.endsWith('.js') || lowerBin.endsWith('.cjs')) {
        child = spawn(process.execPath, [this.agyBin, ...args], {
          cwd: effectiveCwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } else {
        child = spawn(this.agyBin, args, {
          cwd: effectiveCwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: lowerBin.endsWith('.cmd') || lowerBin.endsWith('.bat'),
        });
      }
    } catch (err) {
      session.status = 'failed';
      session.error = err instanceof Error ? err.message : String(err);
      session.updatedAt = new Date().toISOString();
      this.appendLog(session.id, 'stderr', `Failed to spawn agy: ${session.error}`);
      this.persistAndEmit(session);
      this.emit('session:failed', session);
      return;
    }

    this.processes.set(session.id, child);
    session.pid = child.pid ?? null;
    session.status = 'running';
    session.updatedAt = new Date().toISOString();
    this.persistAndEmit(session);

    const parser = new AgyStreamParser();
    let accumulatedDeltaText = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const events = parser.feed(chunk);
      if (events.length === 0) {
        const plain = chunk.toString('utf-8').trim();
        if (plain) {
          this.appendLog(session.id, 'stdout', plain);
        }
        return;
      }

      for (const ev of events) {
        this.handleStreamEvent(session, ev, (delta) => {
          accumulatedDeltaText += delta;
        });
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) {
        this.appendLog(session.id, 'stderr', text);
      }
    });

    child.on('error', (err) => {
      this.processes.delete(session.id);
      session.pid = null;
      session.status = 'failed';
      session.error = err.message;
      session.updatedAt = new Date().toISOString();
      this.appendLog(session.id, 'stderr', `Process error: ${err.message}`);
      this.persistAndEmit(session);
      this.emit('session:failed', session);
    });

    child.on('close', (code) => {
      for (const ev of parser.flush()) {
        this.handleStreamEvent(session, ev, (delta) => {
          accumulatedDeltaText += delta;
        });
      }

      this.processes.delete(session.id);
      session.pid = null;
      session.exitCode = code;
      const elapsedSec = Math.round(((Date.now() - startedAtMs) / 1000) * 10) / 10;
      if (session.durationSeconds === 0) {
        session.durationSeconds = elapsedSec;
      }
      if (!session.lastResponse && accumulatedDeltaText.trim()) {
        session.lastResponse = accumulatedDeltaText.trim();
      }
      session.updatedAt = new Date().toISOString();

      if (session.status === 'stopped') {
        this.appendLog(session.id, 'system', `Agent stopped by user (exit code ${code ?? 'null'}).`);
        this.persistAndEmit(session);
        this.emit('session:stopped', session);
        return;
      }

      if (code === 0) {
        session.status = 'completed';
        this.appendLog(
          session.id,
          'system',
          `Turn completed in ${session.durationSeconds.toFixed(1)}s (${session.totalTokens.toLocaleString()} total tokens).`
        );
        this.persistAndEmit(session);
        this.emit('session:completed', session);
      } else {
        session.status = 'failed';
        session.error = session.error || `agy exited with code ${code}`;
        this.appendLog(session.id, 'stderr', `Agent failed with exit code ${code}.`);
        this.persistAndEmit(session);
        this.emit('session:failed', session);
      }
    });
  }

  private handleStreamEvent(
    session: ManagedAgentSession,
    ev: AgyStreamEvent,
    onDelta: (delta: string) => void
  ): void {
    if (ev.event === 'init' && 'init' in ev) {
      const initEv = ev as Extract<AgyStreamEvent, { event: 'init' }>;
      if (initEv.conversation_id) {
        session.conversationId = initEv.conversation_id;
      }
      this.appendLog(
        session.id,
        'system',
        `Session initialized (conversation_id=${initEv.conversation_id}, permission_mode=${initEv.init?.permission_mode ?? 'default'})`,
        ev
      );
      session.updatedAt = new Date().toISOString();
      this.persistAndEmit(session);
      return;
    }

    if (ev.event === 'step_update' && 'step_update' in ev) {
      const stepEv = ev as Extract<AgyStreamEvent, { event: 'step_update' }>;
      const su = stepEv.step_update;
      if (su.conversation_id && !session.conversationId) {
        session.conversationId = su.conversation_id;
      }
      if (su.text_delta) {
        onDelta(su.text_delta);
        if (su.text_delta.trim()) {
          this.appendLog(session.id, 'agent', su.text_delta, ev);
        }
      }
      if (su.tool_name) {
        this.appendLog(
          session.id,
          'tool',
          `Tool [${su.tool_name}] (${su.state})`,
          ev
        );
      }
      if (su.usage) {
        this.applyUsageUpdate(session, su.usage);
      }
      session.updatedAt = new Date().toISOString();
      this.persistAndEmit(session);
      return;
    }

    if (ev.event === 'result' && 'result' in ev) {
      const resEv = ev as Extract<AgyStreamEvent, { event: 'result' }>;
      const r = resEv.result;
      if (r.conversation_id) {
        session.conversationId = r.conversation_id;
      }
      if (typeof r.response === 'string' && r.response.trim()) {
        session.lastResponse = r.response.trim();
      }
      if (typeof r.duration_seconds === 'number') {
        session.durationSeconds += Math.round(r.duration_seconds * 10) / 10;
      }
      session.turnCount += Number(r.num_turns ?? 1);
      if (r.usage) {
        this.applyUsageUpdate(session, r.usage);
      }
      if (r.status && r.status !== 'SUCCESS') {
        session.error = r.error || `Result status: ${r.status}`;
      }
      this.appendLog(
        session.id,
        'agent',
        r.response?.trim() || `Result status: ${r.status}`,
        ev
      );
      session.updatedAt = new Date().toISOString();
      this.persistAndEmit(session);
      return;
    }
  }

  private applyUsageUpdate(
    session: ManagedAgentSession,
    usage: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    }
  ): void {
    const input = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    const thinking = Number(usage.thinking_tokens ?? 0);
    const cacheRead = Number(usage.cache_read_tokens ?? 0);
    const total = Number(usage.total_tokens ?? input + output + thinking);

    // Update to the latest cumulative turn numbers reported by the CLI
    session.inputTokens = Math.max(session.inputTokens, input);
    session.outputTokens = Math.max(session.outputTokens, output);
    session.thinkingTokens = Math.max(session.thinkingTokens, thinking);
    session.cacheReadTokens = Math.max(session.cacheReadTokens, cacheRead);
    session.totalTokens = Math.max(session.totalTokens, total);
  }

  /**
   * Stops a running `agy` process and terminates its entire Windows process tree (`taskkill /T /F`).
   */
  public stopSession(sessionId: string): ManagedAgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    const child = this.processes.get(sessionId);
    session.status = 'stopped';
    session.updatedAt = new Date().toISOString();

    if (child && child.pid) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 5000,
          });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
      this.processes.delete(sessionId);
      session.pid = null;
    }

    this.persistAndEmit(session);
    return session;
  }

  /**
   * Stops all running agent processes (used on server shutdown).
   */
  public stopAll(): void {
    for (const sessionId of Array.from(this.processes.keys())) {
      try {
        this.stopSession(sessionId);
      } catch {
        // ignore
      }
    }
  }

  private appendLog(
    sessionId: string,
    stream: AgentLogEntry['stream'],
    text: string,
    rawEvent?: AgyStreamEvent
  ): void {
    const entry: AgentLogEntry = {
      id: crypto.randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      stream,
      text,
      rawEvent,
    };

    const list = this.logs.get(sessionId) ?? [];
    list.push(entry);
    if (list.length > this.maxLogsPerSession) {
      list.shift();
    }
    this.logs.set(sessionId, list);

    this.hooks.onLogAppend?.(entry);
    this.emit('session:log', entry);
  }

  private persistAndEmit(session: ManagedAgentSession): void {
    this.hooks.onSessionSave?.(session);
    this.emit('session:updated', session);
  }
}
