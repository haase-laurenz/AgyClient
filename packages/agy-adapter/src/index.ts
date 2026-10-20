import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

export type AgyExecutionMode = 'accept-edits' | 'auto' | 'plan';
export type AgyReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgyOutputFormat = 'text' | 'json' | 'stream-json';

export interface AgyUsageMetrics {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

export interface AgyInitEvent {
  event: 'init';
  conversation_id: string;
  init: {
    cwd: string;
    tools: string[];
    permission_mode: string;
  };
}

export interface AgyStepUpdateEvent {
  event: 'step_update';
  step_update: {
    conversation_id: string;
    step_index: number;
    state: 'ACTIVE' | 'DONE' | 'ERROR' | 'RUNNING' | string;
    step_type: 'user_input' | 'agent_response' | 'tool_call' | 'thought' | string;
    text_delta?: string;
    tool_name?: string;
    tool_args?: Record<string, unknown>;
    duration_seconds?: number;
    usage?: AgyUsageMetrics;
  };
}

export interface AgyResultEvent {
  event: 'result';
  result: {
    conversation_id: string;
    status: 'SUCCESS' | 'ERROR' | 'CANCELLED' | string;
    response: string;
    duration_seconds: number;
    num_turns: number;
    usage?: AgyUsageMetrics;
    error?: string;
  };
}

export type AgyStreamEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | {
  event: string;
  conversation_id?: string;
  [key: string]: unknown;
};

export interface AgyModelInfo {
  id: string;
  label: string;
  family: string;
}

export interface AgyLaunchOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: AgyReasoningEffort;
  mode?: AgyExecutionMode;
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
  conversationId?: string;
  continueLast?: boolean;
  project?: string;
  agent?: string;
  addDirs?: string[];
  outputFormat?: AgyOutputFormat;
  printTimeoutSeconds?: number;
  jsonSchema?: string;
}

export interface AgyConversationSummaryRecord {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: string;
  workspaceUris: string[];
  status: string;
  projectId: string;
  agentName: string;
  parentConversationId: string;
  nestingDepth: number;
  notFullyIdle: boolean;
  killed: boolean;
  isLockActive: boolean;
}

export interface AgyTranscriptStep {
  step_index: number;
  source: string;
  type: string;
  status: string;
  created_at: string;
  content?: string;
  thinking?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  tool_calls?: Array<{
    name: string;
    args?: Record<string, unknown>;
  }>;
}

/**
 * Returns the default Antigravity CLI application data directory (`~/.gemini/antigravity-cli`).
 */
export function getDefaultAgyAppDataDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.gemini', 'antigravity-cli');
}

/**
 * Builds a safe CLI argument array for `agy`.
 * Ensures `--print` and the prompt are placed LAST so `--print` never consumes other flags.
 */
export function buildAgyCliArgs(options: AgyLaunchOptions): string[] {
  const args: string[] = [];

  const outputFormat = options.outputFormat ?? 'stream-json';
  args.push('--output-format', outputFormat);

  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.mode) {
    args.push('--mode', options.mode);
  }
  if (options.sandbox) {
    args.push('--sandbox');
  }
  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (options.conversationId) {
    args.push('--conversation', options.conversationId);
  } else if (options.continueLast) {
    args.push('--continue');
  }
  if (options.project) {
    args.push('--project', options.project);
  }
  if (options.agent) {
    args.push('--agent', options.agent);
  }
  if (options.addDirs && options.addDirs.length > 0) {
    for (const dir of options.addDirs) {
      args.push('--add-dir', dir);
    }
  }
  if (options.printTimeoutSeconds && options.printTimeoutSeconds > 0) {
    args.push('--print-timeout', `${options.printTimeoutSeconds}s`);
  }
  if (options.jsonSchema) {
    args.push('--json-schema', options.jsonSchema);
  }

  // CRITICAL: --print must come immediately before the prompt at the end of the argument list
  args.push('--print', options.prompt);

  return args;
}

/**
 * Stateful NDJSON parser for `agy --output-format stream-json`.
 */
export class AgyStreamParser {
  private buffer = '';

  public feed(chunk: string | Buffer): AgyStreamEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    const events: AgyStreamEvent[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const parsed = AgyStreamParser.parseLine(line);
      if (parsed) {
        events.push(parsed);
      }
    }
    return events;
  }

  public flush(): AgyStreamEvent[] {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (!remaining) return [];
    const parsed = AgyStreamParser.parseLine(remaining);
    return parsed ? [parsed] : [];
  }

  public static parseLine(line: string): AgyStreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return null;
    }
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.event === 'string') {
        return obj as AgyStreamEvent;
      }
      // Handle single-object `--output-format json` result
      if (typeof obj.conversation_id === 'string' && typeof obj.status === 'string') {
        return {
          event: 'result',
          result: {
            conversation_id: obj.conversation_id,
            status: obj.status,
            response: typeof obj.response === 'string' ? obj.response : '',
            duration_seconds: typeof obj.duration_seconds === 'number' ? obj.duration_seconds : 0,
            num_turns: typeof obj.num_turns === 'number' ? obj.num_turns : 1,
            usage: obj.usage as AgyUsageMetrics | undefined,
          },
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}

export function inferModelFamily(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('gemini-4')) return 'Gemini 4';
  if (lower.startsWith('gemini-3')) return 'Gemini 3.8';
  if (lower.startsWith('claude-opus')) return 'Claude Opus';
  if (lower.startsWith('claude-sonnet')) return 'Claude Sonnet';
  if (lower.startsWith('gpt-')) return 'GPT-OSS';
  return 'Other';
}

export class AgyCliAdapter {
  private readonly appDataDir: string;
  private readonly agyBin: string;

  constructor(options?: { appDataDir?: string; agyBin?: string }) {
    this.appDataDir = options?.appDataDir ?? getDefaultAgyAppDataDir();
    this.agyBin = options?.agyBin ?? 'agy';
  }

  public getAppDataDir(): string {
    return this.appDataDir;
  }

  public getAgyBin(): string {
    return this.agyBin;
  }

  /**
   * Detects the installed `agy` CLI version.
   */
  public getVersion(): { installed: boolean; version: string | null; error?: string } {
    try {
      const res = spawnSync(this.agyBin, ['--version'], {
        encoding: 'utf-8',
        timeout: 8000,
        windowsHide: true,
      });
      if (res.status === 0 && res.stdout) {
        return { installed: true, version: res.stdout.trim() };
      }
      return {
        installed: false,
        version: null,
        error: res.stderr?.trim() || `Exited with status ${res.status}`,
      };
    } catch (err) {
      return {
        installed: false,
        version: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Queries `agy models` and parses the tab-separated model list.
   */
  public listModels(): AgyModelInfo[] {
    try {
      const res = spawnSync(this.agyBin, ['models'], {
        encoding: 'utf-8',
        timeout: 15000,
        windowsHide: true,
      });
      if (res.status === 0 && res.stdout) {
        return AgyCliAdapter.parseModelsOutput(res.stdout);
      }
    } catch {
      // Fallback to default known models if CLI call times out
    }
    return AgyCliAdapter.getFallbackModels();
  }

  public static parseModelsOutput(stdout: string): AgyModelInfo[] {
    const models: AgyModelInfo[] = [];
    const lines = stdout.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('Fetching')) continue;
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const id = parts[0].trim();
        const label = parts[1].trim();
        if (id && label) {
          models.push({
            id,
            label,
            family: inferModelFamily(id),
          });
        }
      }
    }
    return models.length > 0 ? models : AgyCliAdapter.getFallbackModels();
  }

  public static getFallbackModels(): AgyModelInfo[] {
    const raw: Array<[string, string]> = [
      ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)'],
      ['gemini-4-argon-high', 'Gemini 4 Argon (High)'],
      ['gemini-4-argon-low', 'Gemini 4 Argon (Low)'],
      ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
      ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
      ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
      ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
      ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Medium)'],
      ['claude-opus-5-5-low', 'Claude Opus 5.5 (Low)'],
      ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (High)'],
      ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium)'],
      ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Low)'],
      ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
    ];
    return raw.map(([id, label]) => ({
      id,
      label,
      family: inferModelFamily(id),
    }));
  }

  /**
   * Reads conversation summaries from `~/.gemini/antigravity-cli/conversation_summaries.db`.
   */
  public listCliConversations(limit = 100): AgyConversationSummaryRecord[] {
    const dbPath = path.join(this.appDataDir, 'conversation_summaries.db');
    const presenceDir = path.join(this.appDataDir, 'presence');
    const activeLocks = new Set<string>();

    if (fs.existsSync(presenceDir)) {
      try {
        for (const file of fs.readdirSync(presenceDir)) {
          if (file.endsWith('.lock')) {
            activeLocks.add(file.slice(0, -5));
          }
        }
      } catch {
        // Ignore read errors on presence dir
      }
    }

    if (!fs.existsSync(dbPath)) {
      return [];
    }

    let db: DatabaseSyncType | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const stmt = db.prepare(`
        SELECT
          conversation_id,
          title,
          preview,
          step_count,
          last_modified_time,
          workspace_uris,
          status,
          project_id,
          agent_name,
          parent_conversation_id,
          nesting_depth,
          not_fully_idle,
          killed
        FROM conversation_summaries
        ORDER BY last_modified_time DESC
        LIMIT ?
      `);
      const rows = stmt.all(limit) as Array<Record<string, unknown>>;
      return rows.map((row) => {
        let workspaceUris: string[] = [];
        if (typeof row.workspace_uris === 'string' && row.workspace_uris) {
          try {
            const parsed = JSON.parse(row.workspace_uris);
            if (Array.isArray(parsed)) {
              workspaceUris = parsed.map((u) => AgyCliAdapter.fileUriToPath(String(u)));
            }
          } catch {
            workspaceUris = [String(row.workspace_uris)];
          }
        }
        const convId = String(row.conversation_id ?? '');
        return {
          conversationId: convId,
          title: String(row.title ?? ''),
          preview: String(row.preview ?? ''),
          stepCount: Number(row.step_count ?? 0),
          lastModifiedTime: String(row.last_modified_time ?? ''),
          workspaceUris,
          status: String(row.status ?? ''),
          projectId: String(row.project_id ?? ''),
          agentName: String(row.agent_name ?? ''),
          parentConversationId: String(row.parent_conversation_id ?? ''),
          nestingDepth: Number(row.nesting_depth ?? 0),
          notFullyIdle: Boolean(row.not_fully_idle),
          killed: Boolean(row.killed),
          isLockActive: activeLocks.has(convId),
        };
      });
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close error
      }
    }
  }

  /**
   * Reads the `transcript.jsonl` file for a specific conversation ID from `brain/<id>/.system_generated/logs/transcript.jsonl`.
   */
  public readConversationTranscript(conversationId: string): AgyTranscriptStep[] {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
      return [];
    }
    const transcriptPath = path.join(
      this.appDataDir,
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }
    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const steps: AgyTranscriptStep[] = [];
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          steps.push(JSON.parse(trimmed) as AgyTranscriptStep);
        } catch {
          // Skip malformed lines
        }
      }
      return steps;
    } catch {
      return [];
    }
  }

  /**
   * Lists all conversation IDs present in `~/.gemini/antigravity-cli/brain`.
   */
  public listBrainConversationIds(): string[] {
    const brainDir = path.join(this.appDataDir, 'brain');
    if (!fs.existsSync(brainDir)) return [];
    try {
      return fs.readdirSync(brainDir).filter((name) => {
        const full = path.join(brainDir, name);
        try {
          return fs.statSync(full).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  public static fileUriToPath(uri: string): string {
    if (!uri.startsWith('file://')) return uri;
    try {
      const decoded = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''));
      return decoded.replace(/\//g, path.sep);
    } catch {
      return uri;
    }
  }
}
