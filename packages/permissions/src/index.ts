import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDefaultAgyAppDataDir } from '@agy-client/agy-adapter';

export type PermissionCategory = 'allow' | 'ask' | 'deny';
export type PermissionScope = 'command' | 'read_file' | 'write_file' | 'read_url' | 'execute_url' | 'mcp';

export interface AgyPermissionsConfig {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface AgySettingsFile {
  permissions: AgyPermissionsConfig;
  trustedWorkspaces: string[];
  [key: string]: unknown;
}

export interface RuleValidationResult {
  valid: boolean;
  rule: string;
  scope?: PermissionScope;
  pattern?: string;
  isRegex?: boolean;
  error?: string;
}

export interface CommandEvaluationResult {
  decision: 'allow' | 'ask' | 'deny';
  matchedRule?: string;
  matchedLayer: 'settings_deny' | 'builtin_destructive_guard' | 'settings_ask' | 'settings_allow' | 'default_ask';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
}

export interface PermissionBackupInfo {
  id: string;
  filename: string;
  createdAt: string;
  path: string;
  sizeBytes: number;
}

export interface PermissionPreset {
  id: string;
  name: string;
  description: string;
  permissions: AgyPermissionsConfig;
}

const VALID_SCOPES = new Set<PermissionScope>([
  'command',
  'read_file',
  'write_file',
  'read_url',
  'execute_url',
  'mcp',
]);

/**
 * Built-in multi-layer destructive command patterns that catch direct deletion commands
 * as well as interpreter/subshell bypasses on Windows.
 */
const BUILTIN_DESTRUCTIVE_PATTERNS: Array<{
  id: string;
  regex: RegExp;
  riskLevel: 'high' | 'critical';
  reason: string;
  action: 'deny' | 'ask';
}> = [
  {
    id: 'direct-shell-delete',
    regex: /\b(del|erase|rmdir|rd|Remove-Item|ri|rm|unlink|Clear-Content|clc)\b/i,
    riskLevel: 'critical',
    reason: 'Direct file or directory deletion command detected.',
    action: 'deny',
  },
  {
    id: 'interpreter-delete-bypass',
    regex: /\b(fs\.(rmSync|unlinkSync|rmdirSync|rm|unlink)|os\.(remove|unlink|rmdir)|shutil\.rmtree|pathlib\.Path.*unlink|System\.IO\.(File|Directory)::Delete)\b/i,
    riskLevel: 'critical',
    reason: 'Inline script file-deletion bypass (Node/Python/.NET) detected.',
    action: 'deny',
  },
  {
    id: 'git-destructive-reset',
    regex: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force|branch\s+-D)\b/i,
    riskLevel: 'high',
    reason: 'Destructive Git history or working-tree operation requires confirmation.',
    action: 'ask',
  },
  {
    id: 'disk-system-destructive',
    regex: /\b(Format-Volume|format\.com|diskpart|cipher\s+\/w|reg\s+delete|sc\s+delete)\b/i,
    riskLevel: 'critical',
    reason: 'System or volume destructive command blocked.',
    action: 'deny',
  },
];

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: 'autonomous-safe',
    name: 'Autonomous with Deletion Guardrails (Recommended)',
    description:
      'Auto-approves routine file reads/writes, MCP tools, and build/test commands while strictly blocking file/folder deletions and asking before destructive Git operations.',
    permissions: {
      allow: [
        'command(*)',
        'read_file(*)',
        'write_file(*)',
        'read_url(*)',
        'execute_url(*)',
        'mcp(*)',
      ],
      ask: [
        'command(regex:.*\\bgit\\s+(reset\\s+--hard|clean\\s+-[a-z]*f|push\\s+.*--force)\\b.*)',
      ],
      deny: [
        'command(regex:.*\\b(del|erase|rmdir)\\b.*)',
        'command(regex:.*\\bRemove-Item\\b.*)',
        'command(regex:.*\\brd\\b.*)',
        'command(regex:.*\\bClear-Content\\b.*)',
        'command(regex:.*\\b(rm|unlink|ri)\\b.*)',
        'command(regex:.*(fs\\.(rmSync|unlinkSync|rmdirSync)|os\\.(remove|unlink)|shutil\\.rmtree).*)',
      ],
    },
  },
  {
    id: 'balanced-developer',
    name: 'Balanced Developer Mode',
    description:
      'Allows all file reads/writes and MCP tools automatically, asks before running arbitrary shell commands, and denies deletions.',
    permissions: {
      allow: ['read_file(*)', 'write_file(*)', 'read_url(*)', 'mcp(*)'],
      ask: ['command(*)', 'execute_url(*)'],
      deny: [
        'command(regex:.*\\b(del|erase|rmdir|Remove-Item|rd|Clear-Content|rm|unlink)\\b.*)',
      ],
    },
  },
  {
    id: 'read-only-research',
    name: 'Read-Only Research Mode',
    description:
      'Allows reading files and web URLs, asks before MCP calls, and denies all file writes and shell commands.',
    permissions: {
      allow: ['read_file(*)', 'read_url(*)'],
      ask: ['mcp(*)'],
      deny: ['write_file(*)', 'command(*)'],
    },
  },
];

export class PermissionsManager {
  private readonly settingsPath: string;
  private readonly backupDir: string;

  constructor(options?: { settingsPath?: string; backupDir?: string }) {
    const defaultAppData = getDefaultAgyAppDataDir();
    this.settingsPath = options?.settingsPath ?? path.join(defaultAppData, 'settings.json');
    this.backupDir = options?.backupDir ?? path.join(defaultAppData, 'backups-agyclient');
  }

  public getSettingsPath(): string {
    return this.settingsPath;
  }

  /**
   * Validates a single Antigravity permission rule string, e.g. `command(regex:.*\bdel\b.*)` or `read_file(*)`.
   */
  public static validateRule(rule: string): RuleValidationResult {
    const trimmed = rule.trim();
    const match = /^([a-z_]+)\((.+)\)$/.exec(trimmed);
    if (!match) {
      return {
        valid: false,
        rule: trimmed,
        error: 'Rule must follow the format <scope>(<pattern>), e.g. command(*) or command(regex:.*)',
      };
    }

    const scope = match[1] as PermissionScope;
    const pattern = match[2];

    if (!VALID_SCOPES.has(scope)) {
      return {
        valid: false,
        rule: trimmed,
        error: `Invalid scope "${scope}". Allowed scopes: ${Array.from(VALID_SCOPES).join(', ')}`,
      };
    }

    if (!pattern || pattern.trim().length === 0) {
      return {
        valid: false,
        rule: trimmed,
        scope,
        error: 'Pattern inside parentheses cannot be empty.',
      };
    }

    if (pattern.startsWith('regex:')) {
      const expr = pattern.slice('regex:'.length);
      if (!expr) {
        return {
          valid: false,
          rule: trimmed,
          scope,
          isRegex: true,
          error: 'Regular expression pattern after "regex:" cannot be empty.',
        };
      }
      try {
        new RegExp(expr);
      } catch (err) {
        return {
          valid: false,
          rule: trimmed,
          scope,
          pattern,
          isRegex: true,
          error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { valid: true, rule: trimmed, scope, pattern, isRegex: true };
    }

    return { valid: true, rule: trimmed, scope, pattern, isRegex: false };
  }

  /**
   * Reads the current `settings.json` file (or returns a safe default if missing).
   */
  public readSettings(): AgySettingsFile {
    if (!fs.existsSync(this.settingsPath)) {
      return {
        permissions: { allow: [], ask: [], deny: [] },
        trustedWorkspaces: [],
      };
    }
    const raw = fs.readFileSync(this.settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const perms = (parsed.permissions ?? {}) as Record<string, unknown>;

    return {
      ...parsed,
      permissions: {
        allow: Array.isArray(perms.allow) ? perms.allow.map(String) : [],
        ask: Array.isArray(perms.ask) ? perms.ask.map(String) : [],
        deny: Array.isArray(perms.deny) ? perms.deny.map(String) : [],
      },
      trustedWorkspaces: Array.isArray(parsed.trustedWorkspaces)
        ? parsed.trustedWorkspaces.map(String)
        : [],
    };
  }

  /**
   * Creates a timestamped backup of `settings.json` before modifying it.
   */
  public createBackup(): PermissionBackupInfo | null {
    if (!fs.existsSync(this.settingsPath)) {
      return null;
    }
    fs.mkdirSync(this.backupDir, { recursive: true });
    const now = new Date();
    const id = now.toISOString().replace(/[:.]/g, '-');
    const filename = `settings-${id}.json`;
    const targetPath = path.join(this.backupDir, filename);
    fs.copyFileSync(this.settingsPath, targetPath);
    const stat = fs.statSync(targetPath);

    return {
      id,
      filename,
      createdAt: now.toISOString(),
      path: targetPath,
      sizeBytes: stat.size,
    };
  }

  /**
   * Lists available `settings.json` backups in reverse chronological order.
   */
  public listBackups(): PermissionBackupInfo[] {
    if (!fs.existsSync(this.backupDir)) {
      return [];
    }
    const files = fs.readdirSync(this.backupDir).filter((f) => f.startsWith('settings-') && f.endsWith('.json'));
    const infos: PermissionBackupInfo[] = files.map((filename) => {
      const fullPath = path.join(this.backupDir, filename);
      const stat = fs.statSync(fullPath);
      return {
        id: filename.replace(/^settings-/, '').replace(/\.json$/, ''),
        filename,
        createdAt: stat.mtime.toISOString(),
        path: fullPath,
        sizeBytes: stat.size,
      };
    });
    return infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Restores a specific backup by ID or filename.
   */
  public restoreBackup(idOrFilename: string): AgySettingsFile {
    const backups = this.listBackups();
    const found = backups.find((b) => b.id === idOrFilename || b.filename === idOrFilename);
    if (!found) {
      throw new Error(`Backup "${idOrFilename}" not found.`);
    }
    this.createBackup();
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.copyFileSync(found.path, this.settingsPath);
    return this.readSettings();
  }

  /**
   * Validates and saves updated permissions and trustedWorkspaces to `settings.json`.
   */
  public updateSettings(update: {
    permissions?: Partial<AgyPermissionsConfig>;
    trustedWorkspaces?: string[];
  }): { settings: AgySettingsFile; backup: PermissionBackupInfo | null } {
    const current = this.readSettings();
    const nextPermissions: AgyPermissionsConfig = {
      allow: update.permissions?.allow ?? current.permissions.allow,
      ask: update.permissions?.ask ?? current.permissions.ask,
      deny: update.permissions?.deny ?? current.permissions.deny,
    };

    // Validate all rules before writing
    for (const category of ['allow', 'ask', 'deny'] as const) {
      const deduplicated = Array.from(new Set(nextPermissions[category].map((r) => r.trim()).filter(Boolean)));
      for (const rule of deduplicated) {
        const validation = PermissionsManager.validateRule(rule);
        if (!validation.valid) {
          throw new Error(`Invalid ${category.toUpperCase()} rule "${rule}": ${validation.error}`);
        }
      }
      nextPermissions[category] = deduplicated;
    }

    const nextWorkspaces = update.trustedWorkspaces
      ? Array.from(new Set(update.trustedWorkspaces.map((w) => w.trim()).filter(Boolean)))
      : current.trustedWorkspaces;

    const backup = this.createBackup();
    const nextSettings: AgySettingsFile = {
      ...current,
      permissions: nextPermissions,
      trustedWorkspaces: nextWorkspaces,
    };

    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', 'utf-8');

    return { settings: nextSettings, backup };
  }

  /**
   * Evaluates a shell command or tool action against both `settings.json` rules
   * and AgyClient's multi-layered destructive-command guardrails.
   */
  public evaluateAction(scope: PermissionScope, target: string): CommandEvaluationResult {
    const settings = this.readSettings();

    // 1. Check explicit DENY rules in settings.json first (highest precedence)
    for (const rule of settings.permissions.deny) {
      if (PermissionsManager.matchesRule(rule, scope, target)) {
        return {
          decision: 'deny',
          matchedRule: rule,
          matchedLayer: 'settings_deny',
          riskLevel: 'critical',
          reason: `Blocked by explicit Deny rule: ${rule}`,
        };
      }
    }

    // 2. Check built-in multi-layer destructive command guardrails for commands
    if (scope === 'command') {
      for (const guard of BUILTIN_DESTRUCTIVE_PATTERNS) {
        if (guard.regex.test(target)) {
          return {
            decision: guard.action,
            matchedRule: `builtin:${guard.id}`,
            matchedLayer: 'builtin_destructive_guard',
            riskLevel: guard.riskLevel,
            reason: guard.reason,
          };
        }
      }
    }

    // 3. Check explicit ASK rules in settings.json
    for (const rule of settings.permissions.ask) {
      if (PermissionsManager.matchesRule(rule, scope, target)) {
        return {
          decision: 'ask',
          matchedRule: rule,
          matchedLayer: 'settings_ask',
          riskLevel: 'medium',
          reason: `Requires confirmation per Ask rule: ${rule}`,
        };
      }
    }

    // 4. Check explicit ALLOW rules in settings.json
    for (const rule of settings.permissions.allow) {
      if (PermissionsManager.matchesRule(rule, scope, target)) {
        return {
          decision: 'allow',
          matchedRule: rule,
          matchedLayer: 'settings_allow',
          riskLevel: 'low',
          reason: `Permitted by Allow rule: ${rule}`,
        };
      }
    }

    // 5. Default fallback is ASK
    return {
      decision: 'ask',
      matchedLayer: 'default_ask',
      riskLevel: 'medium',
      reason: 'No matching rule found; defaults to requesting confirmation.',
    };
  }

  public static matchesRule(rule: string, scope: PermissionScope, target: string): boolean {
    const parsed = PermissionsManager.validateRule(rule);
    if (!parsed.valid || parsed.scope !== scope || !parsed.pattern) {
      return false;
    }
    if (parsed.pattern === '*') {
      return true;
    }
    if (parsed.isRegex) {
      const expr = parsed.pattern.slice('regex:'.length);
      try {
        const re = new RegExp(expr, 'i');
        return re.test(target);
      } catch {
        return false;
      }
    }
    // Simple wildcard glob matching
    const escaped = parsed.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`, 'i');
    return re.test(target);
  }

  /**
   * Windows NTFS OS-Level Delete Protection (`icacls`)
   * Denies `DE` (Delete) and `DC` (Delete Child) permissions on a target folder for the current user
   * while keeping Read, Write, Create, and Execute permissions intact.
   */
  public static getWindowsDeleteLockCommands(targetDir: string, username?: string): {
    enableCommand: string;
    disableCommand: string;
    checkCommand: string;
  } {
    const user = username || process.env.USERNAME || 'Users';
    const normalizedDir = path.resolve(targetDir);
    return {
      enableCommand: `icacls "${normalizedDir}" /deny "${user}:(OI)(CI)(DE,DC)"`,
      disableCommand: `icacls "${normalizedDir}" /remove:d "${user}"`,
      checkCommand: `icacls "${normalizedDir}"`,
    };
  }

  /**
   * Applies or removes Windows NTFS OS-level delete restriction (`(DE,DC)`) on a workspace directory.
   */
  public setDirectoryDeleteProtection(targetDir: string, enable: boolean): {
    success: boolean;
    output: string;
    command: string;
  } {
    const resolved = path.resolve(targetDir);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Target directory does not exist: ${resolved}`);
    }
    const user = process.env.USERNAME;
    if (!user) {
      throw new Error('Could not determine current Windows USERNAME.');
    }

    const args = enable
      ? [resolved, '/deny', `${user}:(OI)(CI)(DE,DC)`]
      : [resolved, '/remove:d', user];

    const res = spawnSync('icacls', args, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 10000,
    });

    return {
      success: res.status === 0,
      output: (res.stdout || res.stderr || '').trim(),
      command: `icacls ${args.map((a) => `"${a}"`).join(' ')}`,
    };
  }

  /**
   * Checks whether Windows NTFS `(DE,DC)` deny ACL is currently active on a directory.
   */
  public checkDirectoryDeleteProtection(targetDir: string): {
    protected: boolean;
    rawAcl: string;
  } {
    const resolved = path.resolve(targetDir);
    if (!fs.existsSync(resolved)) {
      return { protected: false, rawAcl: '' };
    }
    const res = spawnSync('icacls', [resolved], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
    });
    const out = (res.stdout || '').trim();
    const isProtected = /\(DENY\)/i.test(out) || /\(N\)/i.test(out);
    return {
      protected: isProtected,
      rawAcl: out,
    };
  }
}
