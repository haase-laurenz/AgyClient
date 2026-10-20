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
  resolveAgyBinary,
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
  allowSubagents?: boolean;
  subagentRole?: string | null;
  fastResponse?: boolean;
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
  allowSubagents?: boolean;
  subagentRole?: string | null;
  fastResponse?: boolean;
  prompt: string;
  model?: string;
  effort?: AgyReasoningEffort;
  mode?: AgyExecutionMode;
  sandbox?: boolean;
  timeoutSeconds?: number;
}

export interface SubagentDirective {
  title: string;
  role: string;
  prompt: string;
  model?: string;
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
  private readonly nativeSubagentMap = new Map<string, string>();
  private readonly spawnedDirectives = new Set<string>();
  private readonly hooks: ProcessManagerPersistenceHooks;
  private readonly maxLogsPerSession: number;

  constructor(options?: {
    agyBin?: string;
    hooks?: ProcessManagerPersistenceHooks;
    maxLogsPerSession?: number;
    initialSessions?: ManagedAgentSession[];
  }) {
    super();
    this.agyBin = resolveAgyBinary(options?.agyBin);
    this.hooks = options?.hooks ?? {};
    this.maxLogsPerSession = options?.maxLogsPerSession ?? 5000;

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

  public getSubagents(parentSessionId: string): ManagedAgentSession[] {
    const parent = this.sessions.get(parentSessionId);
    return Array.from(this.sessions.values())
      .filter(
        (s) =>
          s.parentSessionId === parentSessionId ||
          (parent?.conversationId && s.parentSessionId === parent.conversationId)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public getSessionLogs(sessionId: string): AgentLogEntry[] {
    return this.logs.get(sessionId) ?? [];
  }

  public hydrateSessionLogs(sessionId: string, entries: AgentLogEntry[]): void {
    this.logs.set(sessionId, entries.slice(-this.maxLogsPerSession));
  }

  /**
   * Formats a prompt with Fast Response & Pretty Batch Streaming instructions when `fastResponse` is enabled.
   */
  public static formatPromptWithFastResponse(prompt: string, fastResponse?: boolean): string {
    const clean = ProcessManager.stripFastResponseDirective(prompt);
    if (!fastResponse) {
      return clean;
    }
    return [
      '[FAST_RESPONSE_MODE]',
      'Fast Response & Pretty Batch Mode:',
      '1. Emit a concise initial Markdown batch immediately (before or alongside your first tool call) so the user receives instant feedback.',
      '2. Stream your answer in self-contained Markdown batches (headings, bullet lists, paragraphs, and code blocks separated by blank lines) after each milestone.',
      '3. Keep tool calls minimal and targeted for maximum speed.',
      '[/FAST_RESPONSE_MODE]',
      '',
      clean,
    ].join('\n');
  }

  /**
   * Strips any `[FAST_RESPONSE_MODE]...[/FAST_RESPONSE_MODE]` wrapper from a prompt string.
   */
  public static stripFastResponseDirective(prompt: string): string {
    return prompt
      .replace(/^\[FAST_RESPONSE_MODE\][\s\S]*?\[\/FAST_RESPONSE_MODE\]\s*/i, '')
      .trim();
  }

  /**
   * Coalesces consecutive `step_update` `text_delta` events belonging to the same `step_index`
   * within a single stdout buffer read into a single batch event to reduce SQLite/WebSocket overhead.
   */
  public static coalesceStreamEventsBatch(events: AgyStreamEvent[]): AgyStreamEvent[] {
    if (events.length <= 1) return events;
    const coalesced: AgyStreamEvent[] = [];

    for (const ev of events) {
      const prev = coalesced[coalesced.length - 1];
      if (
        prev &&
        prev.event === 'step_update' &&
        'step_update' in prev &&
        ev.event === 'step_update' &&
        'step_update' in ev
      ) {
        const prevSu = prev.step_update;
        const currSu = ev.step_update;
        if (
          prevSu.step_type === 'agent_response' &&
          currSu.step_type === 'agent_response' &&
          prevSu.step_index === currSu.step_index &&
          !prevSu.tool_name &&
          !currSu.tool_name &&
          typeof prevSu.text_delta === 'string' &&
          typeof currSu.text_delta === 'string' &&
          prevSu.state === 'ACTIVE'
        ) {
          coalesced[coalesced.length - 1] = {
            ...ev,
            step_update: {
              ...currSu,
              text_delta: prevSu.text_delta + currSu.text_delta,
              usage: currSu.usage ?? prevSu.usage,
              duration_seconds: currSu.duration_seconds ?? prevSu.duration_seconds,
            },
          };
          continue;
        }
      }
      coalesced.push(ev);
    }

    return coalesced;
  }

  /**
   * Extracts structured `<subagent title="..." role="...">prompt</subagent>` directives from agent responses.
   */
  public static extractSubagentDirectives(text: string): SubagentDirective[] {
    const directives: SubagentDirective[] = [];
    const tagRegex = /<subagent\b([^>]*)>([\s\S]*?)<\/subagent>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(text)) !== null) {
      const attrs = match[1] || '';
      const prompt = (match[2] || '').trim();
      if (!prompt) continue;

      const titleMatch = /title\s*=\s*"([^"]+)"/i.exec(attrs);
      const roleMatch = /role\s*=\s*"([^"]+)"/i.exec(attrs);
      const modelMatch = /model\s*=\s*"([^"]+)"/i.exec(attrs);

      const role = roleMatch ? roleMatch[1].trim() : 'SubAgent';
      const title = titleMatch
        ? titleMatch[1].trim()
        : `[${role}] ${prompt.slice(0, 50)}`;

      directives.push({
        title,
        role,
        prompt,
        model: modelMatch ? modelMatch[1].trim() : undefined,
      });
    }
    return directives;
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

    const cleanPrompt = ProcessManager.stripFastResponseDirective(req.prompt);
    const fastResponse = Boolean(req.fastResponse);
    const effectiveEffort: AgyReasoningEffort = req.effort || (fastResponse ? 'low' : 'medium');

    const session: ManagedAgentSession = {
      id,
      title: req.title?.trim() || cleanPrompt.slice(0, 65) || `Agent ${id.slice(0, 8)}`,
      projectId: req.projectId ?? null,
      workspacePath: req.workspacePath,
      worktreePath: req.worktreePath ?? null,
      branchName: req.branchName ?? null,
      conversationId: req.conversationId ?? null,
      parentSessionId: req.parentSessionId ?? null,
      executionRole: req.executionRole ?? (req.parentSessionId ? 'subagent' : 'independent'),
      allowSubagents: req.allowSubagents ?? true,
      subagentRole: req.subagentRole ?? null,
      fastResponse,
      model: req.model || (fastResponse ? 'gemini-3.8-flash-low' : 'gemini-4-argon-medium'),
      effort: effectiveEffort,
      mode: req.mode || 'auto',
      sandbox: Boolean(req.sandbox),
      status: 'starting',
      pid: null,
      prompt: cleanPrompt,
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

    this.spawnAgyTurn(session, cleanPrompt, req.timeoutSeconds);
    return session;
  }

  /**
   * Spawns a child SubAgent session linked to a parent Agent session for more complex tasks.
   */
  public spawnSubagent(
    parentSessionId: string,
    req: {
      title?: string;
      prompt: string;
      subagentRole?: string | null;
      fastResponse?: boolean;
      model?: string;
      effort?: AgyReasoningEffort;
      mode?: AgyExecutionMode;
      sandbox?: boolean;
      worktreePath?: string | null;
      branchName?: string | null;
      allowSubagents?: boolean;
      timeoutSeconds?: number;
    }
  ): ManagedAgentSession {
    const parent = this.sessions.get(parentSessionId);
    if (!parent) {
      throw new Error(`Parent session "${parentSessionId}" not found.`);
    }
    if (parent.allowSubagents === false) {
      throw new Error(`Parent session "${parent.title}" has SubAgent spawning disabled.`);
    }

    const roleLabel = req.subagentRole?.trim() || 'SubAgent';
    const childTitle =
      req.title?.trim() || `[${roleLabel}] ${req.prompt.trim().slice(0, 52)}`;
    const fastResponse = req.fastResponse ?? parent.fastResponse ?? false;

    const child = this.startSession({
      title: childTitle,
      projectId: parent.projectId,
      workspacePath: parent.workspacePath,
      worktreePath: req.worktreePath !== undefined ? req.worktreePath : parent.worktreePath,
      branchName: req.branchName !== undefined ? req.branchName : parent.branchName,
      parentSessionId: parent.id,
      executionRole: 'subagent',
      allowSubagents: req.allowSubagents ?? false,
      subagentRole: roleLabel,
      fastResponse,
      prompt: req.prompt,
      model: req.model || parent.model,
      effort: req.effort || (fastResponse ? 'low' : parent.effort),
      mode: req.mode || parent.mode,
      sandbox: req.sandbox ?? parent.sandbox,
      timeoutSeconds: req.timeoutSeconds,
    });

    this.appendLog(
      parent.id,
      'system',
      `Spawned SubAgent [${roleLabel}]: "${child.title}" (session=${child.id.slice(0, 8)})`
    );
    parent.updatedAt = new Date().toISOString();
    this.persistAndEmit(parent);
    this.emit('subagent:spawned', { parent, subagent: child });

    return child;
  }

  /**
   * Sends a follow-up prompt to an existing session by resuming its `conversationId` with `agy --conversation <id>`.
   */
  public sendFollowUpPrompt(
    sessionId: string,
    prompt: string,
    timeoutSeconds?: number,
    options?: {
      fastResponse?: boolean;
      effort?: AgyReasoningEffort;
      model?: string;
    }
  ): ManagedAgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }
    if (this.processes.has(sessionId)) {
      throw new Error(`Session "${sessionId}" is currently running a turn.`);
    }

    const cleanPrompt = ProcessManager.stripFastResponseDirective(prompt);
    session.prompt = cleanPrompt;
    if (options?.fastResponse !== undefined) {
      session.fastResponse = options.fastResponse;
      if (options.fastResponse && !options.effort) {
        session.effort = 'low';
      }
    }
    if (options?.effort) {
      session.effort = options.effort;
    }
    if (options?.model) {
      session.model = options.model;
    }
    session.status = 'starting';
    session.error = null;
    session.updatedAt = new Date().toISOString();
    this.persistAndEmit(session);

    this.spawnAgyTurn(session, cleanPrompt, timeoutSeconds);
    return session;
  }

  private spawnAgyTurn(
    session: ManagedAgentSession,
    prompt: string,
    timeoutSeconds?: number
  ): void {
    const effectiveCwd = session.worktreePath || session.workspacePath;
    const cliPrompt = ProcessManager.formatPromptWithFastResponse(prompt, session.fastResponse);
    const args = buildAgyCliArgs({
      prompt: cliPrompt,
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
      const rawEvents = parser.feed(chunk);
      if (rawEvents.length === 0) {
        const plain = chunk.toString('utf-8').trim();
        if (plain) {
          this.appendLog(session.id, 'stdout', plain);
        }
        return;
      }

      const events = ProcessManager.coalesceStreamEventsBatch(rawEvents);
      for (const ev of events) {
        this.handleStreamEvent(session, ev, (delta) => {
          accumulatedDeltaText += delta;
          if (accumulatedDeltaText.trim()) {
            session.lastResponse = accumulatedDeltaText.trim();
          }
        });
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) {
        this.appendLog(session.id, 'stderr', text);
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.processes.delete(session.id);
      session.pid = null;
      session.status = 'failed';
      if (err.code === 'ENOENT') {
        session.error = `Antigravity CLI ('${this.agyBin}') was not found on this machine (ENOENT). Please install the Google Antigravity CLI ('agy') and ensure it is in your PATH (or set AGY_BIN).`;
      } else {
        session.error = err.message;
      }
      session.updatedAt = new Date().toISOString();
      this.appendLog(session.id, 'stderr', `Process error: ${session.error}`);
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

        // Complete any native invoke_subagent sessions attached to this parent turn
        for (const child of this.getSubagents(session.id)) {
          if (!this.processes.has(child.id) && (child.status === 'running' || child.status === 'starting')) {
            child.status = 'completed';
            child.updatedAt = new Date().toISOString();
            this.appendLog(child.id, 'system', 'Native SubAgent completed.');
            this.persistAndEmit(child);
          }
        }

        // Automatically spawn SubAgents if the agent emitted <subagent ...> directives
        if (session.allowSubagents !== false && session.lastResponse) {
          const directives = ProcessManager.extractSubagentDirectives(session.lastResponse);
          for (const dir of directives) {
            const dirKey = `${session.id}:${dir.role}:${dir.title}:${dir.prompt}`;
            if (!this.spawnedDirectives.has(dirKey)) {
              this.spawnedDirectives.add(dirKey);
              try {
                this.spawnSubagent(session.id, {
                  title: dir.title,
                  subagentRole: dir.role,
                  prompt: dir.prompt,
                  model: dir.model,
                });
              } catch {
                // ignore if subagent spawn fails
              }
            }
          }
        }

        if (session.parentSessionId) {
          const parent = this.sessions.get(session.parentSessionId);
          if (parent) {
            this.appendLog(
              parent.id,
              'system',
              `SubAgent "${session.title}" completed in ${session.durationSeconds.toFixed(1)}s (${session.totalTokens.toLocaleString()} tokens).`
            );
            parent.updatedAt = new Date().toISOString();
            this.persistAndEmit(parent);
          }
        }

        this.emit('session:completed', session);
      } else {
        session.status = 'failed';
        session.error = session.error || `agy exited with code ${code}`;
        this.appendLog(session.id, 'stderr', `Agent failed with exit code ${code}.`);
        this.persistAndEmit(session);

        if (session.parentSessionId) {
          const parent = this.sessions.get(session.parentSessionId);
          if (parent) {
            this.appendLog(
              parent.id,
              'stderr',
              `SubAgent "${session.title}" failed: ${session.error}`
            );
            parent.updatedAt = new Date().toISOString();
            this.persistAndEmit(parent);
          }
        }

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
        if (su.text_delta.length > 0) {
          this.appendLog(session.id, 'agent', su.text_delta, ev);
        }
      }
      if (su.tool_name) {
        if (!su.tool_args && su.tool_info?.parameters) {
          su.tool_args = su.tool_info.parameters;
        }
        this.appendLog(
          session.id,
          'tool',
          `Tool [${su.tool_name}] (${su.state})`,
          ev
        );

        // Track native invoke_subagent tool calls as hierarchical child SubAgent sessions
        if (
          session.allowSubagents !== false &&
          (su.tool_name === 'invoke_subagent' || su.tool_name === 'default_api:invoke_subagent')
        ) {
          const mapKey = `${session.id}:step:${su.step_index ?? 0}`;
          const existingChildId = this.nativeSubagentMap.get(mapKey);
          const args = su.tool_args || su.tool_info?.parameters || {};
          const role = String(args.Role || args.TypeName || 'SubAgent');
          const subPrompt = String(args.Prompt || 'Delegated complex subtask');
          const subModel =
            typeof args.Model === 'string' && args.Model !== 'inherit'
              ? args.Model
              : session.model;

          if (!existingChildId) {
            const now = new Date().toISOString();
            const childId = crypto.randomUUID();
            const childSession: ManagedAgentSession = {
              id: childId,
              title: `[${role}] ${subPrompt.slice(0, 52)}`,
              projectId: session.projectId,
              workspacePath: session.workspacePath,
              worktreePath: session.worktreePath,
              branchName: session.branchName,
              conversationId: null,
              parentSessionId: session.id,
              executionRole: 'subagent',
              allowSubagents: false,
              subagentRole: role,
              fastResponse: session.fastResponse,
              model: subModel,
              effort: session.effort,
              mode: session.mode,
              sandbox: session.sandbox,
              status: su.state === 'DONE' ? 'completed' : 'running',
              pid: session.pid,
              prompt: subPrompt,
              lastResponse:
                su.state === 'DONE'
                  ? `Completed native SubAgent task (${role}).`
                  : '',
              inputTokens: 0,
              outputTokens: 0,
              thinkingTokens: 0,
              cacheReadTokens: 0,
              totalTokens: 0,
              turnCount: 1,
              durationSeconds: su.duration_seconds ?? 0,
              exitCode: su.state === 'DONE' ? 0 : null,
              error: null,
              createdAt: now,
              updatedAt: now,
            };
            this.nativeSubagentMap.set(mapKey, childId);
            this.sessions.set(childId, childSession);
            this.logs.set(childId, []);
            this.appendLog(
              childId,
              'system',
              `Native SubAgent invoked by "${session.title}" (Role: ${role})`
            );
            this.persistAndEmit(childSession);
          } else {
            const childSession = this.sessions.get(existingChildId);
            if (childSession) {
              if (su.state === 'DONE') {
                childSession.status = 'completed';
                childSession.exitCode = 0;
                childSession.durationSeconds = su.duration_seconds ?? childSession.durationSeconds;
                if (!childSession.lastResponse) {
                  childSession.lastResponse = `Completed native SubAgent task (${role}).`;
                }
                this.appendLog(
                  childSession.id,
                  'system',
                  `SubAgent finished in ${(childSession.durationSeconds || 0).toFixed(1)}s.`
                );
              } else if (su.state === 'ERROR') {
                childSession.status = 'failed';
                childSession.error = 'SubAgent tool invocation failed';
              }
              childSession.updatedAt = new Date().toISOString();
              this.persistAndEmit(childSession);
            }
          }
        }
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
   * Stops a running `agy` process and terminates its process tree across Windows (`taskkill /T /F`) and Linux/macOS (`pkill -P` + `SIGTERM`).
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
          try {
            spawnSync('pkill', ['-TERM', '-P', String(child.pid)], {
              timeout: 3000,
            });
          } catch {
            // ignore if pkill is unavailable
          }
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

    // Also stop any active child SubAgents spawned by this session
    for (const sub of this.getSubagents(sessionId)) {
      if (sub.status === 'running' || sub.status === 'starting') {
        try {
          this.stopSession(sub.id);
        } catch {
          // ignore
        }
      }
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
