import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { AgyExecutionMode, AgyReasoningEffort } from '@agy-client/agy-adapter';
import { ManagedAgentSession, ProcessManager } from '@agy-client/process-manager';
import { GitWorktreeManager } from '@agy-client/git-manager';

export type TaskExecutionStrategy = 'independent_process' | 'subagent';
export type WorkflowTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowTaskDefinition {
  id: string;
  name: string;
  role: 'research' | 'implement' | 'review' | 'test' | 'custom';
  strategy: TaskExecutionStrategy;
  prompt: string;
  dependsOn: string[];
  model?: string;
  effort?: AgyReasoningEffort;
  mode?: AgyExecutionMode;
  useWorktree?: boolean;
  timeoutSeconds?: number;
}

export interface WorkflowTaskState extends WorkflowTaskDefinition {
  status: WorkflowTaskStatus;
  sessionId: string | null;
  worktreePath: string | null;
  branchName: string | null;
  resultText: string;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowRun {
  id: string;
  name: string;
  description: string;
  workspacePath: string;
  projectId: string | null;
  maxConcurrency: number;
  status: WorkflowStatus;
  tasks: WorkflowTaskState[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  maxConcurrency: number;
  tasks: WorkflowTaskDefinition[];
}

export const BUILTIN_WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'research-implement-verify',
    name: 'Feature Pipeline (Research → Implement → Parallel Review & Test)',
    description:
      'Runs an initial codebase research agent, passes findings to an implementation agent in an isolated worktree, then runs code review and test verification in parallel.',
    maxConcurrency: 2,
    tasks: [
      {
        id: 'research',
        name: '1. Codebase Research & Design',
        role: 'research',
        strategy: 'independent_process',
        prompt:
          'Analyze the repository structure and summarize the architecture, key modules, and test setup concisely.',
        dependsOn: [],
        model: 'gemini-3.8-flash-high',
        effort: 'medium',
        mode: 'plan',
        useWorktree: false,
        timeoutSeconds: 180,
      },
      {
        id: 'implement',
        name: '2. Implementation',
        role: 'implement',
        strategy: 'independent_process',
        prompt:
          'Based on the upstream research summary, propose or implement improvements and document any changes made.',
        dependsOn: ['research'],
        model: 'gemini-4-argon-medium',
        effort: 'medium',
        mode: 'auto',
        useWorktree: true,
        timeoutSeconds: 300,
      },
      {
        id: 'review',
        name: '3a. Security & Code Review',
        role: 'review',
        strategy: 'independent_process',
        prompt:
          'Review the upstream implementation for edge cases, security guardrails, and TypeScript best practices.',
        dependsOn: ['implement'],
        model: 'claude-sonnet-5-5-medium',
        effort: 'medium',
        mode: 'plan',
        useWorktree: false,
        timeoutSeconds: 180,
      },
      {
        id: 'test',
        name: '3b. Test Verification',
        role: 'test',
        strategy: 'independent_process',
        prompt:
          'Verify that unit tests pass and suggest any additional test cases needed for full coverage.',
        dependsOn: ['implement'],
        model: 'gemini-3.8-flash-high',
        effort: 'medium',
        mode: 'auto',
        useWorktree: false,
        timeoutSeconds: 180,
      },
    ],
  },
  {
    id: 'subagent-deep-audit',
    name: 'Parent Session with Subagent Delegation',
    description:
      'Launches a coordinator session that uses Antigravity native subagents (research + self) to audit architecture and security in parallel.',
    maxConcurrency: 1,
    tasks: [
      {
        id: 'coordinator',
        name: 'Coordinator with Native Subagents',
        role: 'research',
        strategy: 'subagent',
        prompt:
          'Coordinate a quick audit of this workspace. Use the research subagent to inspect project files and summarize your findings.',
        dependsOn: [],
        model: 'gemini-4-argon-medium',
        effort: 'medium',
        mode: 'plan',
        useWorktree: false,
        timeoutSeconds: 240,
      },
    ],
  },
];

export class WorkflowOrchestrator extends EventEmitter {
  private readonly processManager: ProcessManager;
  private readonly gitManager: GitWorktreeManager;
  private readonly workflows = new Map<string, WorkflowRun>();
  private readonly onWorkflowSave?: (workflow: WorkflowRun) => void;

  constructor(options: {
    processManager: ProcessManager;
    gitManager: GitWorktreeManager;
    onWorkflowSave?: (workflow: WorkflowRun) => void;
    initialWorkflows?: WorkflowRun[];
  }) {
    super();
    this.processManager = options.processManager;
    this.gitManager = options.gitManager;
    this.onWorkflowSave = options.onWorkflowSave;

    if (options.initialWorkflows) {
      for (const wf of options.initialWorkflows) {
        this.workflows.set(wf.id, wf);
      }
    }

    this.processManager.on('session:completed', (session: ManagedAgentSession) => {
      this.handleSessionFinished(session, 'completed');
    });
    this.processManager.on('session:failed', (session: ManagedAgentSession) => {
      this.handleSessionFinished(session, 'failed');
    });
    this.processManager.on('session:stopped', (session: ManagedAgentSession) => {
      this.handleSessionFinished(session, 'failed');
    });
  }

  public listWorkflows(): WorkflowRun[] {
    return Array.from(this.workflows.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  public getWorkflow(id: string): WorkflowRun | undefined {
    return this.workflows.get(id);
  }

  public createAndStartWorkflow(input: {
    name: string;
    description?: string;
    workspacePath: string;
    projectId?: string | null;
    maxConcurrency?: number;
    tasks: WorkflowTaskDefinition[];
  }): WorkflowRun {
    // Validate DAG dependencies
    WorkflowOrchestrator.validateDag(input.tasks);

    const now = new Date().toISOString();
    const wf: WorkflowRun = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description || '',
      workspacePath: input.workspacePath,
      projectId: input.projectId ?? null,
      maxConcurrency: Math.max(1, input.maxConcurrency ?? 2),
      status: 'running',
      tasks: input.tasks.map((t) => ({
        ...t,
        status: 'pending',
        sessionId: null,
        worktreePath: null,
        branchName: null,
        resultText: '',
        error: null,
        startedAt: null,
        completedAt: null,
      })),
      createdAt: now,
      updatedAt: now,
    };

    this.workflows.set(wf.id, wf);
    this.persistAndEmit(wf);
    this.scheduleNextTasks(wf);
    return wf;
  }

  public cancelWorkflow(workflowId: string): WorkflowRun {
    const wf = this.workflows.get(workflowId);
    if (!wf) {
      throw new Error(`Workflow "${workflowId}" not found.`);
    }
    wf.status = 'cancelled';
    for (const task of wf.tasks) {
      if (task.status === 'running' && task.sessionId) {
        try {
          this.processManager.stopSession(task.sessionId);
        } catch {
          // ignore
        }
        task.status = 'failed';
        task.error = 'Cancelled by user';
      } else if (task.status === 'pending') {
        task.status = 'skipped';
      }
    }
    wf.updatedAt = new Date().toISOString();
    this.persistAndEmit(wf);
    return wf;
  }

  private scheduleNextTasks(wf: WorkflowRun): void {
    if (wf.status !== 'running') return;

    const runningCount = wf.tasks.filter((t) => t.status === 'running').length;
    const availableSlots = Math.max(0, wf.maxConcurrency - runningCount);

    for (const task of wf.tasks) {
      if (task.status !== 'pending') continue;

      const deps = wf.tasks.filter((d) => task.dependsOn.includes(d.id));
      const anyDepFailed = deps.some((d) => d.status === 'failed' || d.status === 'skipped');
      if (anyDepFailed) {
        task.status = 'skipped';
        task.error = 'Skipped due to upstream dependency failure.';
        task.completedAt = new Date().toISOString();
      }
    }

    let launched = 0;
    for (const task of wf.tasks) {
      if (launched >= availableSlots) break;
      if (task.status !== 'pending') continue;

      const deps = wf.tasks.filter((d) => task.dependsOn.includes(d.id));
      const allDepsCompleted = deps.every((d) => d.status === 'completed');
      if (!allDepsCompleted) continue;

      this.launchTask(wf, task, deps);
      launched += 1;
    }

    // Check if workflow is now finished
    const stillActive = wf.tasks.some((t) => t.status === 'pending' || t.status === 'running');
    if (!stillActive) {
      const anyFailed = wf.tasks.some((t) => t.status === 'failed');
      wf.status = anyFailed ? 'failed' : 'completed';
    }

    wf.updatedAt = new Date().toISOString();
    this.persistAndEmit(wf);
  }

  private launchTask(
    wf: WorkflowRun,
    task: WorkflowTaskState,
    completedDeps: WorkflowTaskState[]
  ): void {
    task.status = 'running';
    task.startedAt = new Date().toISOString();

    let worktreePath: string | null = null;
    let branchName: string | null = null;

    if (task.useWorktree) {
      try {
        const wt = this.gitManager.createWorktree(
          wf.workspacePath,
          `${wf.id.slice(0, 6)}-${task.id}`
        );
        worktreePath = wt.worktreePath;
        branchName = wt.branch;
        task.worktreePath = worktreePath;
        task.branchName = branchName;
      } catch {
        // Fallback to main workspace path if worktree creation is unavailable
      }
    }

    let effectivePrompt = task.prompt;
    if (completedDeps.length > 0) {
      const contextBlocks = completedDeps
        .map(
          (d) =>
            `--- Upstream Task [${d.name}] Result ---\n${d.resultText || '(Completed with no text output)'}`
        )
        .join('\n\n');
      effectivePrompt = `${contextBlocks}\n\n--- Current Task [${task.name}] Instructions ---\n${task.prompt}`;
    }

    if (task.strategy === 'subagent') {
      effectivePrompt = `[Subagent Execution Mode: Please use the invoke_subagent tool (e.g., TypeName="research" or "self") where helpful to parallelize subtasks.]\n\n${effectivePrompt}`;
    }

    try {
      const session = this.processManager.startSession({
        title: `[${wf.name}] ${task.name}`,
        projectId: wf.projectId,
        workspacePath: wf.workspacePath,
        worktreePath,
        branchName,
        executionRole: task.strategy === 'subagent' ? 'subagent' : 'workflow-task',
        prompt: effectivePrompt,
        model: task.model || 'gemini-4-argon-medium',
        effort: task.effort || 'medium',
        mode: task.mode || 'auto',
        timeoutSeconds: task.timeoutSeconds,
      });
      task.sessionId = session.id;
    } catch (err) {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = new Date().toISOString();
    }
  }

  private handleSessionFinished(
    session: ManagedAgentSession,
    outcome: 'completed' | 'failed'
  ): void {
    for (const wf of this.workflows.values()) {
      if (wf.status !== 'running') continue;
      const task = wf.tasks.find((t) => t.sessionId === session.id);
      if (!task) continue;

      task.status = outcome;
      task.resultText = session.lastResponse || '';
      task.error = session.error;
      task.completedAt = new Date().toISOString();

      this.scheduleNextTasks(wf);
    }
  }

  public static validateDag(tasks: WorkflowTaskDefinition[]): void {
    if (!tasks || tasks.length === 0) {
      throw new Error('Workflow must contain at least one task.');
    }
    const ids = new Set(tasks.map((t) => t.id));
    if (ids.size !== tasks.length) {
      throw new Error('Workflow task IDs must be unique.');
    }

    for (const t of tasks) {
      for (const dep of t.dependsOn) {
        if (!ids.has(dep)) {
          throw new Error(`Task "${t.id}" depends on unknown task "${dep}".`);
        }
        if (dep === t.id) {
          throw new Error(`Task "${t.id}" cannot depend on itself.`);
        }
      }
    }

    // Detect cycles via DFS
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Circular dependency detected involving task "${id}".`);
      }
      visiting.add(id);
      const node = taskMap.get(id)!;
      for (const dep of node.dependsOn) {
        visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const t of tasks) {
      visit(t.id);
    }
  }

  private persistAndEmit(wf: WorkflowRun): void {
    this.onWorkflowSave?.(wf);
    this.emit('workflow:updated', wf);
  }
}
