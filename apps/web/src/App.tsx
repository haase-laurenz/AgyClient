import React, { useEffect, useState, useCallback } from 'react';
import {
  TokenActivityAreaChart,
  ModelDistributionDonutChart,
  QuotaRadialGauge,
  TokenCompositionStackedBars,
  WorkflowDagGraph,
  ConcurrencySwimlaneGantt,
  SecurityDefenseDonut,
} from './Charts';
import {
  AgentSessionStreamView,
  FinalResponseCard,
  MarkdownRenderer,
  AgentLogEntry,
} from './AgentResponseRenderer';

type TabId = 'overview' | 'agents' | 'permissions' | 'usage' | 'workflows';

interface HealthStatus {
  status: string;
  appName: string;
  boundHost: string;
  agyCli: { installed: boolean; version: string | null };
  activeProcesses: number;
  totalManagedSessions: number;
  defaultWorkspacePath: string;
}

interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  description: string;
  isGitRepo?: boolean;
  currentBranch?: string | null;
  deleteProtected?: boolean;
}

interface ManagedSession {
  id: string;
  title: string;
  projectId: string | null;
  workspacePath: string;
  worktreePath: string | null;
  branchName: string | null;
  conversationId: string | null;
  parentSessionId: string | null;
  executionRole: string;
  allowSubagents?: boolean;
  subagentRole?: string | null;
  model: string;
  effort: string;
  mode: string;
  sandbox: boolean;
  status: 'starting' | 'running' | 'idle' | 'completed' | 'stopped' | 'failed';
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

interface CliConversation {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: string;
  workspaceUris: string[];
  parentConversationId: string;
  nestingDepth: number;
  isLockActive: boolean;
}

interface ModelInfo {
  id: string;
  label: string;
  family: string;
}

interface SessionTreeNode {
  session: ManagedSession;
  children: SessionTreeNode[];
  depth: number;
  descendantCount: number;
  activeDescendantCount: number;
  aggregatedTokens: number;
}

function buildSessionHierarchy(sessions: ManagedSession[]): SessionTreeNode[] {
  const byId = new Map<string, ManagedSession>();
  const convIdToSessionId = new Map<string, string>();

  for (const s of sessions) {
    byId.set(s.id, s);
    if (s.conversationId) {
      convIdToSessionId.set(s.conversationId, s.id);
    }
  }

  const childrenMap = new Map<string, ManagedSession[]>();
  const roots: ManagedSession[] = [];

  for (const s of sessions) {
    let resolvedParentId: string | null = null;
    if (s.parentSessionId) {
      if (byId.has(s.parentSessionId) && s.parentSessionId !== s.id) {
        resolvedParentId = s.parentSessionId;
      } else if (convIdToSessionId.has(s.parentSessionId)) {
        const mapped = convIdToSessionId.get(s.parentSessionId)!;
        if (mapped !== s.id) {
          resolvedParentId = mapped;
        }
      }
    }

    if (resolvedParentId) {
      const list = childrenMap.get(resolvedParentId) || [];
      list.push(s);
      childrenMap.set(resolvedParentId, list);
    } else {
      roots.push(s);
    }
  }

  const visited = new Set<string>();

  const buildNode = (session: ManagedSession, depth: number): SessionTreeNode => {
    visited.add(session.id);
    const rawChildren = (childrenMap.get(session.id) || [])
      .filter((c) => !visited.has(c.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const childNodes = rawChildren.map((c) => buildNode(c, depth + 1));
    const descendantCount = childNodes.reduce((acc, c) => acc + 1 + c.descendantCount, 0);
    const activeDescendantCount = childNodes.reduce(
      (acc, c) =>
        acc +
        (c.session.status === 'running' || c.session.status === 'starting' ? 1 : 0) +
        c.activeDescendantCount,
      0
    );
    const aggregatedTokens =
      session.totalTokens + childNodes.reduce((acc, c) => acc + c.aggregatedTokens, 0);

    return {
      session,
      children: childNodes,
      depth,
      descendantCount,
      activeDescendantCount,
      aggregatedTokens,
    };
  };

  return roots
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((r) => buildNode(r, 0));
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [wsConnected, setWsConnected] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [cliConversations, setCliConversations] = useState<CliConversation[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionLogs, setSessionLogs] = useState<AgentLogEntry[]>([]);
  const [followUpPrompt, setFollowUpPrompt] = useState('');

  // Launch form state
  const [launchTitle, setLaunchTitle] = useState('');
  const [launchWorkspace, setLaunchWorkspace] = useState('');
  const [launchModel, setLaunchModel] = useState('gemini-4-argon-medium');
  const [launchEffort, setLaunchEffort] = useState('medium');
  const [launchMode, setLaunchMode] = useState('auto');
  const [launchSandbox, setLaunchSandbox] = useState(false);
  const [launchUseWorktree, setLaunchUseWorktree] = useState(false);
  const [launchAllowSubagents, setLaunchAllowSubagents] = useState(true);
  const [launchPromptsText, setLaunchPromptsText] = useState(
    'Summarize the key modules in this repository in 3 bullet points.'
  );
  const [launching, setLaunching] = useState(false);

  // SubAgent Hierarchy & Spawner state
  const [collapsedParents, setCollapsedParents] = useState<Record<string, boolean>>({});
  const [subagentParentId, setSubagentParentId] = useState<string | null>(null);
  const [subagentTitle, setSubagentTitle] = useState('');
  const [subagentRole, setSubagentRole] = useState('Researcher');
  const [subagentModel, setSubagentModel] = useState('');
  const [subagentUseWorktree, setSubagentUseWorktree] = useState(false);
  const [subagentAllowNested, setSubagentAllowNested] = useState(false);
  const [subagentPromptsText, setSubagentPromptsText] = useState(
    'Analyze the architecture and edge cases of this module and return a concise technical summary.'
  );
  const [spawningSubagent, setSpawningSubagent] = useState(false);

  // New project form
  const [newProjName, setNewProjName] = useState('');
  const [newProjPath, setNewProjPath] = useState('');

  // Permissions state
  const [permData, setPermData] = useState<{
    settingsPath: string;
    settings: {
      permissions: { allow: string[]; ask: string[]; deny: string[] };
      trustedWorkspaces: string[];
    };
    presets: Array<{
      id: string;
      name: string;
      description: string;
      permissions: { allow: string[]; ask: string[]; deny: string[] };
    }>;
    backups: Array<{ id: string; filename: string; createdAt: string; sizeBytes: number }>;
    auditLogs: Array<{
      id: string;
      timestamp: string;
      action: string;
      riskLevel: string;
      details: string;
    }>;
  } | null>(null);
  const [allowText, setAllowText] = useState('');
  const [askText, setAskText] = useState('');
  const [denyText, setDenyText] = useState('');
  const [confirmSecChange, setConfirmSecChange] = useState(false);
  const [permStatusMsg, setPermStatusMsg] = useState('');
  const [evalScope, setEvalScope] = useState('command');
  const [evalTarget, setEvalTarget] = useState('Remove-Item -Force secret.txt');
  const [evalResult, setEvalResult] = useState<{
    decision: string;
    matchedRule?: string;
    matchedLayer: string;
    riskLevel: string;
    reason: string;
  } | null>(null);

  // Usage state
  const [usageData, setUsageData] = useState<any>(null);

  // Workflows & Git Worktrees state
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [wfTemplates, setWfTemplates] = useState<any[]>([]);
  const [worktrees, setWorktrees] = useState<any[]>([]);
  const [selectedWorktreeDiff, setSelectedWorktreeDiff] = useState<any>(null);
  const [newWorktreeSlug, setNewWorktreeSlug] = useState('');
  const [gitMessage, setGitMessage] = useState('');

  const fetchCoreData = useCallback(async () => {
    try {
      const [hRes, mRes, pRes, sRes, uRes, wRes] = await Promise.all([
        fetch('/api/health'),
        fetch('/api/models'),
        fetch('/api/projects'),
        fetch('/api/sessions'),
        fetch('/api/usage'),
        fetch('/api/workflows'),
      ]);
      if (hRes.ok) {
        const h = await hRes.json();
        setHealth(h);
        setLaunchWorkspace((prev) => prev || h.defaultWorkspacePath || '');
      }
      if (mRes.ok) {
        const m = await mRes.json();
        setModels(m.models || []);
      }
      if (pRes.ok) {
        const p = await pRes.json();
        setProjects(p.projects || []);
      }
      if (sRes.ok) {
        const s = await sRes.json();
        setSessions(s.sessions || []);
        setCliConversations(s.cliConversations || []);
        if (!selectedSessionId && s.sessions?.length > 0) {
          setSelectedSessionId(s.sessions[0].id);
        }
      }
      if (uRes.ok) {
        setUsageData(await uRes.json());
      }
      if (wRes.ok) {
        const w = await wRes.json();
        setWorkflows(w.workflows || []);
        setWfTemplates(w.templates || []);
      }
    } catch {
      // ignore transient network errors
    }
  }, [selectedSessionId]);

  const fetchPermissions = useCallback(async () => {
    const res = await fetch('/api/permissions');
    if (res.ok) {
      const data = await res.json();
      setPermData(data);
      setAllowText((data.settings?.permissions?.allow || []).join('\n'));
      setAskText((data.settings?.permissions?.ask || []).join('\n'));
      setDenyText((data.settings?.permissions?.deny || []).join('\n'));
    }
  }, []);

  const fetchWorktrees = useCallback(async () => {
    const repo = launchWorkspace || health?.defaultWorkspacePath || '';
    const url = repo
      ? `/api/git/worktrees?repoPath=${encodeURIComponent(repo)}`
      : '/api/git/worktrees';
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      setWorktrees(data.worktrees || []);
    }
  }, [launchWorkspace, health]);

  useEffect(() => {
    fetchCoreData();
    fetchPermissions();
  }, [fetchCoreData, fetchPermissions]);

  useEffect(() => {
    fetchWorktrees();
  }, [fetchWorktrees]);

  // WebSocket live connection
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'session:updated' && msg.session) {
          setSessions((prev) => {
            const idx = prev.findIndex((x) => x.id === msg.session.id);
            if (idx === -1) return [msg.session, ...prev];
            const copy = [...prev];
            copy[idx] = msg.session;
            return copy;
          });
        } else if (msg.type === 'session:log' && msg.log) {
          setSessionLogs((prev) => {
            if (prev.length > 0 && prev[0].sessionId !== msg.log.sessionId) {
              return prev;
            }
            return [...prev, msg.log];
          });
        } else if (msg.type === 'workflow:updated' && msg.workflow) {
          setWorkflows((prev) => {
            const idx = prev.findIndex((w) => w.id === msg.workflow.id);
            if (idx === -1) return [msg.workflow, ...prev];
            const copy = [...prev];
            copy[idx] = msg.workflow;
            return copy;
          });
        }
      } catch {
        // ignore malformed message
      }
    };

    return () => ws.close();
  }, []);

  // Load logs when selectedSessionId changes
  useEffect(() => {
    if (!selectedSessionId) {
      setSessionLogs([]);
      return;
    }
    fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/logs`)
      .then((r) => (r.ok ? r.json() : { logs: [] }))
      .then((d) => setSessionLogs(d.logs || []))
      .catch(() => setSessionLogs([]));
  }, [selectedSessionId]);

  const handleLaunchAgents = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompts = launchPromptsText
      .split('\n---\n')
      .map((p) => p.trim())
      .filter(Boolean);
    if (prompts.length === 0) return;

    setLaunching(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: launchTitle || undefined,
          workspacePath: launchWorkspace || health?.defaultWorkspacePath,
          prompts,
          model: launchModel,
          effort: launchEffort,
          mode: launchMode,
          sandbox: launchSandbox,
          useWorktree: launchUseWorktree,
          allowSubagents: launchAllowSubagents,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.session?.id) {
          setSelectedSessionId(data.session.id);
          setActiveTab('agents');
        }
        await fetchCoreData();
      }
    } finally {
      setLaunching(false);
    }
  };

  const handleSpawnSubagents = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subagentParentId) return;
    const prompts = subagentPromptsText
      .split('\n---\n')
      .map((p) => p.trim())
      .filter(Boolean);
    if (prompts.length === 0) return;

    setSpawningSubagent(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(subagentParentId)}/subagents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: subagentTitle || undefined,
          subagentRole,
          prompts,
          model: subagentModel || undefined,
          useWorktree: subagentUseWorktree,
          allowSubagents: subagentAllowNested,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setCollapsedParents((prev) => ({ ...prev, [subagentParentId]: false }));
        if (data.subagent?.id) {
          setSelectedSessionId(data.subagent.id);
        }
        setSubagentTitle('');
        setSubagentParentId(null);
        await fetchCoreData();
      }
    } finally {
      setSpawningSubagent(false);
    }
  };

  const toggleParentCollapse = (parentId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setCollapsedParents((prev) => ({ ...prev, [parentId]: !prev[parentId] }));
  };

  const openSubagentSpawner = (parentSession: ManagedSession, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSubagentParentId(parentSession.id);
    setSubagentModel(parentSession.model);
    setSelectedSessionId(parentSession.id);
  };

  const handleStopSession = async (id: string) => {
    await fetch(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    await fetchCoreData();
  };

  const handleSendFollowUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSessionId || !followUpPrompt.trim()) return;
    const text = followUpPrompt.trim();
    setFollowUpPrompt('');
    await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text }),
    });
  };

  const handleSavePermissions = async () => {
    setPermStatusMsg('');
    const res = await fetch('/api/permissions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        permissions: {
          allow: allowText.split('\n').map((s) => s.trim()).filter(Boolean),
          ask: askText.split('\n').map((s) => s.trim()).filter(Boolean),
          deny: denyText.split('\n').map((s) => s.trim()).filter(Boolean),
        },
        confirmSecurityChange: confirmSecChange,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setPermStatusMsg(`Saved! Automatic backup created: ${data.backup?.filename || 'done'}`);
      setConfirmSecChange(false);
      await fetchPermissions();
    } else {
      setPermStatusMsg(`Error: ${data.error}`);
    }
  };

  const handleEvaluateCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/permissions/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: evalScope, target: evalTarget }),
    });
    if (res.ok) {
      const data = await res.json();
      setEvalResult(data.evaluation);
    }
  };

  const handleToggleDeleteLock = async (dirPath: string, enable: boolean) => {
    const res = await fetch('/api/permissions/delete-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: dirPath,
        enable,
        confirmSecurityChange: true,
      }),
    });
    if (res.ok) {
      await fetchCoreData();
      await fetchPermissions();
    }
  };

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) || null;
  const runningCount = sessions.filter(
    (s) => s.status === 'running' || s.status === 'starting'
  ).length;
  const sessionHierarchy = buildSessionHierarchy(sessions);
  const subagentSessionsCount = sessions.filter(
    (s) => Boolean(s.parentSessionId) || s.executionRole === 'subagent'
  ).length;
  const rootSessionsCount = sessions.length - subagentSessionsCount;

  // Compute ancestor breadcrumb chain and direct SubAgents for the selected session
  const selectedSessionAncestors: ManagedSession[] = [];
  if (selectedSession) {
    let curr: ManagedSession | undefined = selectedSession;
    const seen = new Set<string>([selectedSession.id]);
    while (curr?.parentSessionId) {
      const pid: string = curr.parentSessionId;
      const parent: ManagedSession | undefined = sessions.find(
        (x) => x.id === pid || (x.conversationId && x.conversationId === pid)
      );
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      selectedSessionAncestors.unshift(parent);
      curr = parent;
    }
  }

  const selectedSessionSubagents = selectedSession
    ? sessions
        .filter(
          (s) =>
            s.parentSessionId === selectedSession.id ||
            (selectedSession.conversationId && s.parentSessionId === selectedSession.conversationId)
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];

  const subagentTargetParent = subagentParentId
    ? sessions.find((s) => s.id === subagentParentId) || null
    : null;

  const renderSessionTreeNode = (
    node: SessionTreeNode,
    isLastSibling: boolean
  ): React.ReactNode => {
    const { session: s, children, depth, descendantCount, activeDescendantCount, aggregatedTokens } = node;
    const isSelected = selectedSessionId === s.id;
    const isSubagent = depth > 0 || Boolean(s.parentSessionId) || s.executionRole === 'subagent';
    const isCollapsed = Boolean(collapsedParents[s.id]);
    const canSpawnSubagent = s.allowSubagents !== false;

    return (
      <div
        key={s.id}
        className={`hierarchy-node ${depth > 0 ? 'hierarchy-node-child' : 'hierarchy-node-root'}`}
      >
        <div
          className={`session-item ${isSelected ? 'selected' : ''} ${
            isSubagent ? 'session-item-subagent' : 'session-item-root'
          }`}
          onClick={() => setSelectedSessionId(s.id)}
        >
          <div className="hierarchy-item-header">
            <div className="hierarchy-title-group">
              {depth > 0 && (
                <span className="hierarchy-branch-glyph" title={`Hierarchy Depth L${depth}`}>
                  {isLastSibling ? '└─' : '├─'}
                </span>
              )}
              {children.length > 0 && (
                <button
                  type="button"
                  className="hierarchy-collapse-btn"
                  title={isCollapsed ? 'Expand SubAgents' : 'Collapse SubAgents'}
                  onClick={(e) => toggleParentCollapse(s.id, e)}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
              )}
              <strong style={{ fontSize: '0.88rem' }}>{s.title}</strong>
            </div>

            <div className="hierarchy-badges">
              {isSubagent ? (
                <span className="badge badge-subagent">
                  ↳ {s.subagentRole || 'SUBAGENT'} {depth > 0 ? `(L${depth})` : ''}
                </span>
              ) : children.length > 0 ? (
                <span className="badge badge-coordinator">
                  {descendantCount} SubAgent{descendantCount > 1 ? 's' : ''}
                  {activeDescendantCount > 0 ? ` • ${activeDescendantCount} active` : ''}
                </span>
              ) : null}
              <span
                className={`badge ${
                  s.status === 'running' || s.status === 'starting'
                    ? 'badge-running'
                    : s.status === 'completed'
                    ? 'badge-completed'
                    : s.status === 'failed'
                    ? 'badge-failed'
                    : 'badge-stopped'
                }`}
              >
                {s.status.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="hierarchy-item-meta">
            <span>
              Model: <code>{s.model}</code> | PID: {s.pid ?? '—'} | Tokens:{' '}
              {s.totalTokens.toLocaleString()}
              {children.length > 0 && aggregatedTokens > s.totalTokens && (
                <span style={{ color: '#c4b5fd' }}>
                  {' '}
                  (Tree: {aggregatedTokens.toLocaleString()})
                </span>
              )}{' '}
              | {s.durationSeconds.toFixed(1)}s
            </span>

            {canSpawnSubagent && (
              <button
                type="button"
                className="btn-spawn-subagent-inline"
                title="Spawn a SubAgent under this Agent for more complex tasks"
                onClick={(e) => openSubagentSpawner(s, e)}
              >
                + Spawn SubAgent
              </button>
            )}
          </div>

          {s.branchName && (
            <div style={{ fontSize: '0.73rem', color: '#60a5fa', marginTop: '2px' }}>
              Worktree branch: <code>{s.branchName}</code>
            </div>
          )}
        </div>

        {children.length > 0 && !isCollapsed && (
          <div className="hierarchy-children-container">
            {children.map((childNode, idx) =>
              renderSessionTreeNode(childNode, idx === children.length - 1)
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>AgyClient</h1>
          <span>Antigravity CLI Control Center</span>
        </div>

        <nav className="nav-list">
          <button
            className={`nav-btn ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <span>Dashboard & Launch</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'agents' ? 'active' : ''}`}
            onClick={() => setActiveTab('agents')}
          >
            <span>Agents & Terminals</span>
            {runningCount > 0 && <span className="badge badge-running">{runningCount} active</span>}
          </button>
          <button
            className={`nav-btn ${activeTab === 'permissions' ? 'active' : ''}`}
            onClick={() => setActiveTab('permissions')}
          >
            <span>Permissions & Guardrails</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'usage' ? 'active' : ''}`}
            onClick={() => setActiveTab('usage')}
          >
            <span>Usage & Model Quotas</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'workflows' ? 'active' : ''}`}
            onClick={() => setActiveTab('workflows')}
          >
            <span>Workflows & Worktrees</span>
          </button>
        </nav>

        <div className="sidebar-status">
          <div>
            <strong>CLI Version:</strong>{' '}
            {health?.agyCli?.installed ? `v${health.agyCli.version}` : 'Detecting...'}
          </div>
          <div>
            <strong>Local Host:</strong> {health?.boundHost || '127.0.0.1'}:3000
          </div>
          <div>
            <strong>Live Stream:</strong>{' '}
            <span style={{ color: wsConnected ? '#10b981' : '#f59e0b' }}>
              {wsConnected ? 'Connected (WS)' : 'Reconnecting...'}
            </span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        {activeTab === 'overview' && (
          <div>
            <div className="page-header">
              <h2>Unified Control Center</h2>
              <button className="btn btn-secondary" onClick={fetchCoreData}>
                Refresh Status
              </button>
            </div>

            <div className="grid-4">
              <div className="card">
                <div className="kpi-label">Active Parallel Agents</div>
                <div className="kpi-value">{runningCount}</div>
                <div className="kpi-sub">{sessions.length} total managed sessions</div>
              </div>
              <div className="card">
                <div className="kpi-label">Official Tokens (All-Time)</div>
                <div className="kpi-value">
                  {(usageData?.totals?.totalTokens || 0).toLocaleString()}
                </div>
                <div className="kpi-sub">
                  {usageData?.totals?.totalRequests || 0} turns across{' '}
                  {usageData?.totals?.totalSessions || 0} sessions
                </div>
              </div>
              <div className="card">
                <div className="kpi-label">5h Rolling Window</div>
                <div className="kpi-value">
                  {(usageData?.window5h?.totalTokens || 0).toLocaleString()}
                </div>
                <div className="kpi-sub">
                  {usageData?.window5h?.totalRequests || 0} requests in last 5 hours
                </div>
              </div>
              <div className="card">
                <div className="kpi-label">Guardrails Status</div>
                <div className="kpi-value">
                  {permData?.settings?.permissions?.deny?.length || 0} Deny Rules
                </div>
                <div className="kpi-sub">
                  {permData?.settings?.permissions?.allow?.length || 0} Allow /{' '}
                  {permData?.settings?.permissions?.ask?.length || 0} Ask
                </div>
              </div>
            </div>

            <div className="grid-2">
              <div className="card">
                <h3>
                  <span>Token Telemetry Trend (Recent Sessions)</span>
                  <span className="badge badge-official">Live SVG</span>
                </h3>
                <TokenActivityAreaChart sessions={usageData?.sessions || []} height={195} />
              </div>

              <div className="card">
                <h3>
                  <span>Model Family Token Share &amp; Concurrency</span>
                  <span className="badge badge-running">
                    {Object.keys(usageData?.byModelFamily || {}).length} Families
                  </span>
                </h3>
                <ModelDistributionDonutChart byModelFamily={usageData?.byModelFamily || {}} />
              </div>
            </div>

            <div className="grid-2">
              <div className="card">
                <h3>Launch Independent agy Agent(s)</h3>
                <form onSubmit={handleLaunchAgents}>
                  <div className="form-group">
                    <label>Task Title (optional)</label>
                    <input
                      type="text"
                      placeholder="e.g. Architecture Review or Unit Test Generator"
                      value={launchTitle}
                      onChange={(e) => setLaunchTitle(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label>Workspace Path</label>
                    <select
                      value={launchWorkspace}
                      onChange={(e) => setLaunchWorkspace(e.target.value)}
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.path}>
                          {p.name} ({p.path})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid-2" style={{ marginBottom: 0 }}>
                    <div className="form-group">
                      <label>Model</label>
                      <select
                        value={launchModel}
                        onChange={(e) => setLaunchModel(e.target.value)}
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Reasoning Effort & Mode</label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <select
                          value={launchEffort}
                          onChange={(e) => setLaunchEffort(e.target.value)}
                        >
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="xhigh">X-High</option>
                          <option value="max">Max</option>
                        </select>
                        <select
                          value={launchMode}
                          onChange={(e) => setLaunchMode(e.target.value)}
                        >
                          <option value="auto">Auto</option>
                          <option value="accept-edits">Accept Edits</option>
                          <option value="plan">Plan Mode</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>
                      Prompt(s) — Separate multiple prompts with a line containing <code>---</code>{' '}
                      to launch parallel independent <code>agy</code> processes simultaneously
                    </label>
                    <textarea
                      rows={4}
                      value={launchPromptsText}
                      onChange={(e) => setLaunchPromptsText(e.target.value)}
                    />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px', fontSize: '0.84rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#c4b5fd', fontWeight: 600 }}>
                      <input
                        type="checkbox"
                        checked={launchAllowSubagents}
                        onChange={(e) => setLaunchAllowSubagents(e.target.checked)}
                      />
                      Allow Agents to spawn &ldquo;SubAgents, for more complex tasks.&rdquo;
                    </label>
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input
                          type="checkbox"
                          checked={launchUseWorktree}
                          onChange={(e) => setLaunchUseWorktree(e.target.checked)}
                        />
                        Isolate in dedicated Git Worktree (<code>.worktrees/</code>)
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input
                          type="checkbox"
                          checked={launchSandbox}
                          onChange={(e) => setLaunchSandbox(e.target.checked)}
                        />
                        Enable CLI Terminal Sandbox (<code>--sandbox</code>)
                      </label>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <button type="submit" className="btn btn-primary" disabled={launching}>
                      {launching ? 'Starting Process(es)...' : 'Launch Agent Process(es)'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() =>
                        setLaunchPromptsText(
                          'Reply with a 1-sentence summary of package.json.\n---\nReply with the current git branch name and status.\n---\nList the 6 workspace packages in packages/.'
                        )
                      }
                    >
                      Fill 3-Agent Parallel Demo
                    </button>
                  </div>
                </form>
              </div>

              <div className="card">
                <h3>Registered Projects & Workspaces</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Branch</th>
                      <th>NTFS Delete Guard</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.name}</strong>
                          <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{p.path}</div>
                        </td>
                        <td>
                          {p.isGitRepo ? (
                            <span className="badge badge-running">{p.currentBranch || 'main'}</span>
                          ) : (
                            <span className="badge badge-stopped">No Git</span>
                          )}
                        </td>
                        <td>
                          <button
                            className={`btn ${p.deleteProtected ? 'btn-danger' : 'btn-secondary'}`}
                            style={{ padding: '4px 8px', fontSize: '0.74rem' }}
                            onClick={() => handleToggleDeleteLock(p.path, !p.deleteProtected)}
                          >
                            {p.deleteProtected ? 'NTFS Delete Locked (Unlock)' : 'Enable NTFS Delete Lock'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <form
                  style={{ marginTop: '14px', display: 'flex', gap: '8px' }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newProjPath.trim()) return;
                    const res = await fetch('/api/projects', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: newProjName, path: newProjPath }),
                    });
                    if (res.ok) {
                      setNewProjName('');
                      setNewProjPath('');
                      fetchCoreData();
                    }
                  }}
                >
                  <input
                    type="text"
                    placeholder="Project Name"
                    value={newProjName}
                    onChange={(e) => setNewProjName(e.target.value)}
                    style={{ width: '35%' }}
                  />
                  <input
                    type="text"
                    placeholder="Absolute Folder Path (e.g. C:\Projects\MyApp)"
                    value={newProjPath}
                    onChange={(e) => setNewProjPath(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="submit" className="btn btn-secondary">
                    Add
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'agents' && (
          <div>
            <div className="page-header">
              <div>
                <h2>Agent Hierarchy &amp; Terminal Manager</h2>
                <span style={{ fontSize: '0.82rem', color: '#94a3b8' }}>
                  Agents can spawn <strong>SubAgents, for more complex tasks.</strong> Inspect parent-child hierarchies and live streams below.
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {selectedSession && selectedSession.allowSubagents !== false && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ borderColor: '#8b5cf6', color: '#c4b5fd' }}
                    onClick={() => openSubagentSpawner(selectedSession)}
                  >
                    + Spawn SubAgent
                  </button>
                )}
                <button className="btn btn-primary" onClick={() => setActiveTab('overview')}>
                  + New Root Agent
                </button>
              </div>
            </div>

            {subagentTargetParent && (
              <div className="card subagent-spawner-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <div>
                    <h3 style={{ margin: 0, color: '#c4b5fd' }}>
                      ↳ Spawn SubAgent(s), for more complex tasks.
                    </h3>
                    <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '2px' }}>
                      Parent Agent: <strong>{subagentTargetParent.title}</strong>{' '}
                      <code>({subagentTargetParent.id.slice(0, 8)})</code>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '0.76rem' }}
                    onClick={() => setSubagentParentId(null)}
                  >
                    ✕ Close
                  </button>
                </div>

                <form onSubmit={handleSpawnSubagents}>
                  <div className="grid-2" style={{ marginBottom: 0 }}>
                    <div className="form-group">
                      <label>SubAgent Role</label>
                      <select
                        value={subagentRole}
                        onChange={(e) => setSubagentRole(e.target.value)}
                      >
                        <option value="Researcher">Researcher (Codebase &amp; Docs)</option>
                        <option value="Architect">Architect (System &amp; API Design)</option>
                        <option value="Implementer">Implementer (Feature &amp; Refactoring)</option>
                        <option value="Security & Code Reviewer">Security &amp; Code Reviewer</option>
                        <option value="Test & Verification">Test &amp; Verification Engineer</option>
                        <option value="SubAgent">General SubAgent</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label>SubAgent Title (optional)</label>
                      <input
                        type="text"
                        placeholder={`e.g. [${subagentRole}] Deep Module Audit`}
                        value={subagentTitle}
                        onChange={(e) => setSubagentTitle(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="grid-2" style={{ marginBottom: 0 }}>
                    <div className="form-group">
                      <label>Model (defaults to Parent Agent model)</label>
                      <select
                        value={subagentModel || subagentTargetParent.model}
                        onChange={(e) => setSubagentModel(e.target.value)}
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group" style={{ justifyContent: 'flex-end' }}>
                      <label>SubAgent Isolation &amp; Nesting</label>
                      <div style={{ display: 'flex', gap: '14px', fontSize: '0.8rem', paddingTop: '6px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <input
                            type="checkbox"
                            checked={subagentUseWorktree}
                            onChange={(e) => setSubagentUseWorktree(e.target.checked)}
                          />
                          Dedicated Git Worktree
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '5px', color: '#c4b5fd' }}>
                          <input
                            type="checkbox"
                            checked={subagentAllowNested}
                            onChange={(e) => setSubagentAllowNested(e.target.checked)}
                          />
                          Allow nested SubAgents
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>
                      Complex Subtask Prompt(s) — Separate multiple prompts with <code>---</code> to spawn parallel SubAgents under <strong>{subagentTargetParent.title}</strong>
                    </label>
                    <textarea
                      rows={3}
                      value={subagentPromptsText}
                      onChange={(e) => setSubagentPromptsText(e.target.value)}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button type="submit" className="btn btn-primary" disabled={spawningSubagent}>
                      {spawningSubagent ? 'Spawning SubAgent(s)...' : 'Launch SubAgent(s)'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setSubagentRole('Researcher');
                        setSubagentPromptsText(
                          'Inspect packages/process-manager and summarize how SubAgent sessions are tracked.\n---\nInspect packages/permissions and verify destructive command guardrails.'
                        );
                      }}
                    >
                      Preset: 2 Parallel Research SubAgents
                    </button>
                  </div>
                </form>
              </div>
            )}

            <div className="split-view">
              <div>
                <div className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <div>
                      <h3 style={{ margin: 0 }}>
                        Agent Hierarchy ({sessions.length})
                      </h3>
                      <div style={{ fontSize: '0.74rem', color: '#94a3b8', marginTop: '2px' }}>
                        {rootSessionsCount} Root Agent{rootSessionsCount === 1 ? '' : 's'} •{' '}
                        <span style={{ color: '#c4b5fd' }}>
                          {subagentSessionsCount} SubAgent{subagentSessionsCount === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>
                    {subagentSessionsCount > 0 && (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '3px 8px', fontSize: '0.72rem' }}
                          onClick={() => setCollapsedParents({})}
                        >
                          Expand All
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '3px 8px', fontSize: '0.72rem' }}
                          onClick={() => {
                            const next: Record<string, boolean> = {};
                            for (const s of sessions) next[s.id] = true;
                            setCollapsedParents(next);
                          }}
                        >
                          Collapse All
                        </button>
                      </div>
                    )}
                  </div>

                  {sessions.length === 0 && (
                    <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
                      No processes launched yet. Use the Dashboard to start one or more parallel agents.
                    </div>
                  )}

                  <div className="hierarchy-tree-root">
                    {sessionHierarchy.map((node, idx) =>
                      renderSessionTreeNode(node, idx === sessionHierarchy.length - 1)
                    )}
                  </div>
                </div>

                <div className="card">
                  <h3>Parallel Execution Swimlanes (Duration &amp; Load)</h3>
                  <ConcurrencySwimlaneGantt sessions={sessions} />
                </div>

                <div className="card">
                  <h3>CLI History &amp; Native Subagents ({cliConversations.length})</h3>
                  <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                    {cliConversations.slice(0, 25).map((c) => {
                      const depth = Math.max(0, c.nestingDepth || (c.parentConversationId ? 1 : 0));
                      return (
                        <div
                          key={c.conversationId}
                          style={{
                            padding: '8px 0',
                            paddingLeft: `${depth * 18}px`,
                            borderBottom: '1px solid var(--border-color)',
                            fontSize: '0.8rem',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                            <strong>
                              {depth > 0 && (
                                <span style={{ color: '#a78bfa', marginRight: '5px' }}>↳</span>
                              )}
                              {c.preview || c.title || c.conversationId.slice(0, 8)}
                            </strong>
                            <div style={{ display: 'flex', gap: '4px' }}>
                              {depth > 0 && (
                                <span className="badge badge-subagent">SUBAGENT L{depth}</span>
                              )}
                              {c.isLockActive && <span className="badge badge-running">LOCK</span>}
                            </div>
                          </div>
                          <div style={{ color: '#94a3b8', fontSize: '0.73rem' }}>
                            ID: <code>{c.conversationId.slice(0, 12)}...</code> | Steps: {c.stepCount}
                            {c.parentConversationId && (
                              <span style={{ color: '#c4b5fd' }}>
                                {' '}
                                | Parent: <code>{c.parentConversationId.slice(0, 8)}</code>
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="card">
                {selectedSession ? (
                  <>
                    {selectedSessionAncestors.length > 0 && (
                      <div className="hierarchy-breadcrumb-bar">
                        <span className="hierarchy-breadcrumb-label">Hierarchy Path:</span>
                        {selectedSessionAncestors.map((anc) => (
                          <React.Fragment key={anc.id}>
                            <button
                              type="button"
                              className="hierarchy-breadcrumb-link"
                              onClick={() => setSelectedSessionId(anc.id)}
                            >
                              {anc.title}
                            </button>
                            <span className="hierarchy-breadcrumb-sep">→</span>
                          </React.Fragment>
                        ))}
                        <span className="hierarchy-breadcrumb-current">
                          {selectedSession.title}
                        </span>
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', gap: '10px', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <h3 style={{ margin: 0 }}>{selectedSession.title}</h3>
                          {(selectedSession.parentSessionId ||
                            selectedSession.executionRole === 'subagent') && (
                            <span className="badge badge-subagent">
                              ↳ {selectedSession.subagentRole || 'SubAgent'}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '2px' }}>
                          Conversation ID:{' '}
                          <code>{selectedSession.conversationId || 'assigning...'}</code> | CWD:{' '}
                          <code>{selectedSession.worktreePath || selectedSession.workspacePath}</code>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        {selectedSession.allowSubagents !== false && (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ borderColor: '#8b5cf6', color: '#c4b5fd', padding: '6px 11px', fontSize: '0.78rem' }}
                            onClick={() => openSubagentSpawner(selectedSession)}
                          >
                            + Spawn SubAgent
                          </button>
                        )}
                        {(selectedSession.status === 'running' ||
                          selectedSession.status === 'starting') && (
                          <button
                            className="btn btn-danger"
                            onClick={() => handleStopSession(selectedSession.id)}
                          >
                            Stop Process (PID {selectedSession.pid})
                          </button>
                        )}
                      </div>
                    </div>

                    {selectedSessionSubagents.length > 0 && (
                      <div className="subagents-overview-box">
                        <div className="subagents-overview-header">
                          <span className="kpi-label" style={{ color: '#c4b5fd' }}>
                            ↳ Spawned SubAgents ({selectedSessionSubagents.length})
                          </span>
                          <span style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                            Click any SubAgent to inspect its execution stream
                          </span>
                        </div>
                        <div className="subagents-overview-grid">
                          {selectedSessionSubagents.map((sub) => (
                            <div
                              key={sub.id}
                              className="subagent-mini-card"
                              onClick={() => setSelectedSessionId(sub.id)}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                                <strong style={{ fontSize: '0.8rem', color: '#f1f5f9' }}>
                                  {sub.title}
                                </strong>
                                <span
                                  className={`badge ${
                                    sub.status === 'running' || sub.status === 'starting'
                                      ? 'badge-running'
                                      : sub.status === 'completed'
                                      ? 'badge-completed'
                                      : sub.status === 'failed'
                                      ? 'badge-failed'
                                      : 'badge-stopped'
                                  }`}
                                >
                                  {sub.status.toUpperCase()}
                                </span>
                              </div>
                              <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '4px' }}>
                                Role: <code style={{ color: '#c4b5fd' }}>{sub.subagentRole || 'SubAgent'}</code> •{' '}
                                {sub.totalTokens.toLocaleString()} tok • {sub.durationSeconds.toFixed(1)}s
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <AgentSessionStreamView
                      logs={sessionLogs}
                      sessionPrompt={selectedSession.prompt}
                      lastResponse={selectedSession.lastResponse}
                      sessionStatus={selectedSession.status}
                      model={selectedSession.model}
                    />

                    {selectedSession.lastResponse && (
                      <FinalResponseCard
                        content={selectedSession.lastResponse}
                        model={selectedSession.model}
                        durationSeconds={selectedSession.durationSeconds}
                        totalTokens={selectedSession.totalTokens}
                        turnCount={selectedSession.turnCount}
                        status={selectedSession.status}
                      />
                    )}

                    <form
                      onSubmit={handleSendFollowUp}
                      style={{ marginTop: '14px', display: 'flex', gap: '8px' }}
                    >
                      <input
                        type="text"
                        placeholder="Send follow-up prompt to this conversation (--conversation resume)..."
                        value={followUpPrompt}
                        onChange={(e) => setFollowUpPrompt(e.target.value)}
                        style={{ flex: 1 }}
                        disabled={
                          selectedSession.status === 'running' ||
                          selectedSession.status === 'starting'
                        }
                      />
                      <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={
                          selectedSession.status === 'running' ||
                          selectedSession.status === 'starting' ||
                          !followUpPrompt.trim()
                        }
                      >
                        Send Turn
                      </button>
                    </form>
                  </>
                ) : (
                  <div style={{ color: '#94a3b8' }}>Select an agent session on the left to inspect its live stream.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'permissions' && (
          <div>
            <div className="page-header">
              <h2>Permissions & Security Guardrails</h2>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                Config: <code>{permData?.settingsPath}</code>
              </span>
            </div>

            <div className="grid-2">
              <div className="card">
                <h3>Security Rule Distribution &amp; Defense Posture</h3>
                <SecurityDefenseDonut
                  allowCount={permData?.settings?.permissions?.allow?.length || 0}
                  askCount={permData?.settings?.permissions?.ask?.length || 0}
                  denyCount={permData?.settings?.permissions?.deny?.length || 0}
                  protectedProjectsCount={projects.filter((p) => p.deleteProtected).length}
                />
              </div>

              <div className="card">
                <h3>Quick Security Presets</h3>
                <div className="grid-2" style={{ marginBottom: 0 }}>
                  {(permData?.presets || []).map((preset) => (
                    <div
                      key={preset.id}
                      style={{
                        padding: '12px',
                        borderRadius: '8px',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-color)',
                      }}
                    >
                      <strong style={{ fontSize: '0.88rem' }}>{preset.name}</strong>
                      <p style={{ fontSize: '0.76rem', color: '#94a3b8', margin: '6px 0 10px' }}>
                        {preset.description}
                      </p>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: '0.76rem', padding: '5px 10px' }}
                        onClick={() => {
                          setAllowText(preset.permissions.allow.join('\n'));
                          setAskText(preset.permissions.ask.join('\n'));
                          setDenyText(preset.permissions.deny.join('\n'));
                        }}
                      >
                        Load Preset into Editor
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid-2">
              <div className="card">
                <h3>Central Allow / Ask / Deny Rules Editor</h3>
                <div className="form-group">
                  <label>ALLOW Rules (Routine auto-approved actions, one per line)</label>
                  <textarea
                    rows={5}
                    value={allowText}
                    onChange={(e) => setAllowText(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>ASK Rules (High-risk actions requiring confirmation)</label>
                  <textarea
                    rows={3}
                    value={askText}
                    onChange={(e) => setAskText(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>DENY Rules (Strictly blocked destructive commands, highest priority)</label>
                  <textarea
                    rows={6}
                    value={denyText}
                    onChange={(e) => setDenyText(e.target.value)}
                  />
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.84rem', marginBottom: '12px' }}>
                  <input
                    type="checkbox"
                    checked={confirmSecChange}
                    onChange={(e) => setConfirmSecChange(e.target.checked)}
                  />
                  I confirm modifying Antigravity CLI security rules (creates an automatic backup first)
                </label>

                <button
                  className="btn btn-primary"
                  disabled={!confirmSecChange}
                  onClick={handleSavePermissions}
                >
                  Validate, Backup & Save Rules
                </button>
                {permStatusMsg && (
                  <div style={{ marginTop: '10px', fontSize: '0.83rem', color: '#93c5fd' }}>
                    {permStatusMsg}
                  </div>
                )}
              </div>

              <div>
                <div className="card">
                  <h3>Multi-Layer Destructive Command Dry-Run Tester</h3>
                  <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 0 }}>
                    Tests commands against both <code>settings.json</code> rules and AgyClient&apos;s built-in
                    interpreter bypass guardrails (Node/Python/.NET deletion & Git hard-reset detection).
                  </p>
                  <form onSubmit={handleEvaluateCommand}>
                    <div className="form-group">
                      <label>Scope</label>
                      <select value={evalScope} onChange={(e) => setEvalScope(e.target.value)}>
                        <option value="command">command</option>
                        <option value="write_file">write_file</option>
                        <option value="read_file">read_file</option>
                        <option value="mcp">mcp</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Command or Target to Test</label>
                      <input
                        type="text"
                        value={evalTarget}
                        onChange={(e) => setEvalTarget(e.target.value)}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button type="submit" className="btn btn-primary">
                        Evaluate Decision
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setEvalTarget('node -e "fs.rmSync(\'src\', {recursive:true})"')}
                      >
                        Test Node Bypass
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setEvalTarget('git reset --hard HEAD~1')}
                      >
                        Test Git Reset
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setEvalTarget('npm run test')}
                      >
                        Test Routine Build
                      </button>
                    </div>
                  </form>

                  {evalResult && (
                    <div
                      style={{
                        marginTop: '14px',
                        padding: '12px',
                        borderRadius: '8px',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-color)',
                      }}
                    >
                      <div>
                        <strong>Decision: </strong>
                        <span className={`badge badge-${evalResult.decision}`}>
                          {evalResult.decision.toUpperCase()}
                        </span>{' '}
                        <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                          (Risk: {evalResult.riskLevel.toUpperCase()} | Layer: {evalResult.matchedLayer})
                        </span>
                      </div>
                      <div style={{ fontSize: '0.82rem', marginTop: '6px' }}>{evalResult.reason}</div>
                    </div>
                  )}
                </div>

                <div className="card">
                  <h3>Settings Backups & Security Audit Log</h3>
                  <div style={{ fontSize: '0.8rem', marginBottom: '10px' }}>
                    <strong>Backups ({permData?.backups?.length || 0}):</strong>
                    {(permData?.backups || []).slice(0, 4).map((b) => (
                      <div
                        key={b.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '4px 0',
                        }}
                      >
                        <code>{b.filename}</code>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                          onClick={async () => {
                            await fetch('/api/permissions/restore', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                backupId: b.id,
                                confirmSecurityChange: true,
                              }),
                            });
                            fetchPermissions();
                          }}
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: '0.78rem', maxHeight: '160px', overflowY: 'auto' }}>
                    {(permData?.auditLogs || []).map((a) => (
                      <div key={a.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--border-color)' }}>
                        <span style={{ color: '#94a3b8' }}>
                          [{new Date(a.timestamp).toLocaleTimeString()}]
                        </span>{' '}
                        <strong>{a.action}</strong>: {a.details}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'usage' && (
          <div>
            <div className="page-header">
              <h2>Model Usage, Tokens & Quota Limits</h2>
              <button className="btn btn-secondary" onClick={fetchCoreData}>
                Sync Transcripts
              </button>
            </div>

            <div className="card">
              <h3>Data Source Transparency</h3>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '0.82rem' }}>
                <span className="badge badge-official">
                  OFFICIALLY REPORTED: Token counts, turns, and execution duration (from agy stream-json &amp; transcript.jsonl)
                </span>
                <span className="badge badge-estimated">
                  ESTIMATED / LOCAL BUDGET: Rolling 5h window ceilings configured locally in AgyClient
                </span>
                <span className="badge badge-unavailable">
                  UNAVAILABLE VIA CLI: Upstream Google Cloud server-side quota percentage (not exposed by agy v1.4.3)
                </span>
              </div>
            </div>

            <div className="gauges-grid">
              {(usageData?.quotas || []).map((q: any) => (
                <QuotaRadialGauge key={q.family} quota={q} />
              ))}
            </div>

            <div className="grid-2">
              <div className="card">
                <h3>
                  <span>Token Consumption Curve (Input vs Total)</span>
                  <span className="badge badge-official">Interactive</span>
                </h3>
                <TokenActivityAreaChart sessions={usageData?.sessions || []} height={210} />
              </div>

              <div className="card">
                <h3>
                  <span>Token Composition per Session (Input / Cache / Output)</span>
                  <span className="badge badge-official">Breakdown</span>
                </h3>
                <TokenCompositionStackedBars sessions={usageData?.sessions || []} />
              </div>
            </div>

            <div className="grid-2">
              {(usageData?.quotas || []).map((q: any) => (
                <div key={q.family} className="card">
                  <h3>
                    <span>
                      {q.family} ({q.windowHours}h Rolling Window)
                    </span>
                    <span className="badge badge-estimated">
                      {q.remainingTokenPercent}% Local Budget Remaining
                    </span>
                  </h3>
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${Math.min(100, 100 - q.remainingTokenPercent)}%` }}
                    />
                  </div>
                  <div style={{ fontSize: '0.82rem', display: 'flex', justifyContent: 'space-between' }}>
                    <span>
                      Used: <strong>{q.usedTokens.toLocaleString()}</strong> /{' '}
                      {q.maxTokens.toLocaleString()} tokens
                    </span>
                    <span>
                      Requests: <strong>{q.usedRequests}</strong> / {q.maxRequests}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#94a3b8', marginTop: '6px' }}>
                    {q.officialCloudQuotaNote}
                  </div>
                </div>
              ))}
            </div>

            <div className="card">
              <h3>Per-Session Token &amp; Execution Time Breakdown</h3>
              <table>
                <thead>
                  <tr>
                    <th>Session / Conversation</th>
                    <th>Model</th>
                    <th>Turns</th>
                    <th>Input Tokens</th>
                    <th>Cache Read</th>
                    <th>Output Tokens</th>
                    <th>Total Tokens</th>
                    <th>Duration</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {(usageData?.sessions || []).map((s: any) => (
                    <tr key={s.conversationId}>
                      <td>
                        <strong>{s.title}</strong>
                        <div style={{ fontSize: '0.73rem', color: '#94a3b8' }}>
                          <code>{s.conversationId}</code>
                        </div>
                      </td>
                      <td>{s.model}</td>
                      <td>{s.requestCount}</td>
                      <td>{s.inputTokens.toLocaleString()}</td>
                      <td>{s.cacheReadTokens.toLocaleString()}</td>
                      <td>{s.outputTokens.toLocaleString()}</td>
                      <td>
                        <strong>{s.totalTokens.toLocaleString()}</strong>
                      </td>
                      <td>{s.durationSeconds.toFixed(1)}s</td>
                      <td>
                        <span className="badge badge-official">Official CLI</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'workflows' && (
          <div>
            <div className="page-header">
              <h2>Multi-Agent Orchestration &amp; Git Worktrees</h2>
              <button className="btn btn-secondary" onClick={fetchWorktrees}>
                Refresh Worktrees
              </button>
            </div>

            <div className="grid-2">
              <div className="card">
                <h3>Automated Multi-Agent Workflow Templates</h3>
                {(wfTemplates || []).map((tpl: any) => (
                  <div
                    key={tpl.id}
                    style={{
                      padding: '12px',
                      borderRadius: '8px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)',
                      marginBottom: '12px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>{tpl.name}</strong>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '5px 10px', fontSize: '0.78rem' }}
                        onClick={async () => {
                          await fetch('/api/workflows', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              name: tpl.name,
                              description: tpl.description,
                              workspacePath: launchWorkspace || health?.defaultWorkspacePath,
                              maxConcurrency: tpl.maxConcurrency,
                              tasks: tpl.tasks,
                            }),
                          });
                          fetchCoreData();
                        }}
                      >
                        Run Workflow
                      </button>
                    </div>
                    <p style={{ fontSize: '0.78rem', color: '#94a3b8', margin: '6px 0' }}>
                      {tpl.description}
                    </p>
                    <div style={{ fontSize: '0.74rem', color: '#93c5fd', marginBottom: '6px' }}>
                      Tasks: {tpl.tasks.map((t: any) => `${t.name} (${t.strategy})`).join(' → ')}
                    </div>
                    <WorkflowDagGraph tasks={tpl.tasks} title="Pipeline Topology (DAG)" />
                  </div>
                ))}

                <h3 style={{ marginTop: '18px' }}>Workflow Runs ({workflows.length})</h3>
                {workflows.map((wf: any) => (
                  <div
                    key={wf.id}
                    style={{
                      padding: '12px',
                      borderRadius: '8px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)',
                      marginBottom: '10px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <strong>{wf.name}</strong>
                      <span
                        className={`badge ${
                          wf.status === 'running'
                            ? 'badge-running'
                            : wf.status === 'completed'
                            ? 'badge-completed'
                            : 'badge-failed'
                        }`}
                      >
                        {wf.status.toUpperCase()}
                      </span>
                    </div>
                    <WorkflowDagGraph tasks={wf.tasks} title="Live Execution Graph" />
                    <div style={{ marginTop: '8px', fontSize: '0.8rem' }}>
                      {wf.tasks.map((t: any) => (
                        <div
                          key={t.id}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '4px 0',
                            borderBottom: '1px solid var(--border-color)',
                          }}
                        >
                          <span>
                            {t.name} <code style={{ color: '#94a3b8' }}>[{t.strategy}]</code>
                          </span>
                          <span className="badge badge-stopped">{t.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="card">
                <h3>Git Worktrees &amp; Conflict-Safe Integration</h3>
                <form
                  style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newWorktreeSlug.trim()) return;
                    const res = await fetch('/api/git/worktrees', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        repoPath: launchWorkspace || health?.defaultWorkspacePath,
                        taskSlug: newWorktreeSlug.trim(),
                      }),
                    });
                    if (res.ok) {
                      setNewWorktreeSlug('');
                      fetchWorktrees();
                    }
                  }}
                >
                  <input
                    type="text"
                    placeholder="New isolated worktree slug (e.g. feature-auth)"
                    value={newWorktreeSlug}
                    onChange={(e) => setNewWorktreeSlug(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="submit" className="btn btn-primary">
                    + Create Worktree
                  </button>
                </form>

                {gitMessage && (
                  <div style={{ marginBottom: '12px', fontSize: '0.82rem', color: '#6ee7b7' }}>
                    {gitMessage}
                  </div>
                )}

                <table>
                  <thead>
                    <tr>
                      <th>Branch / Path</th>
                      <th>Changed Files</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {worktrees.map((wt: any) => (
                      <tr key={wt.worktreePath}>
                        <td>
                          <strong>{wt.branch}</strong>{' '}
                          {wt.isMain && <span className="badge badge-running">MAIN</span>}
                          <div style={{ fontSize: '0.73rem', color: '#94a3b8' }}>
                            {wt.worktreePath}
                          </div>
                        </td>
                        <td>{wt.changedFilesCount} modified</td>
                        <td style={{ display: 'flex', gap: '6px' }}>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '4px 8px', fontSize: '0.74rem' }}
                            onClick={async () => {
                              const r = await fetch(
                                `/api/git/diff?worktreePath=${encodeURIComponent(wt.worktreePath)}`
                              );
                              if (r.ok) {
                                const d = await r.json();
                                setSelectedWorktreeDiff(d.diff);
                              }
                            }}
                          >
                            Inspect Diff
                          </button>
                          {!wt.isMain && (
                            <>
                              <button
                                className="btn btn-primary"
                                style={{ padding: '4px 8px', fontSize: '0.74rem' }}
                                onClick={async () => {
                                  const r = await fetch('/api/git/integrate', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      repoPath: launchWorkspace || health?.defaultWorkspacePath,
                                      worktreePath: wt.worktreePath,
                                    }),
                                  });
                                  const d = await r.json();
                                  setGitMessage(
                                    d.merged
                                      ? `Cleanly integrated ${d.branch}!`
                                      : `Conflict check prevented blind merge: ${d.output}`
                                  );
                                  fetchWorktrees();
                                }}
                              >
                                Safe Merge
                              </button>
                              <button
                                className="btn btn-danger"
                                style={{ padding: '4px 8px', fontSize: '0.74rem' }}
                                onClick={async () => {
                                  await fetch('/api/git/worktrees', {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      repoPath: launchWorkspace || health?.defaultWorkspacePath,
                                      worktreePath: wt.worktreePath,
                                      force: true,
                                    }),
                                  });
                                  fetchWorktrees();
                                }}
                              >
                                Remove
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {selectedWorktreeDiff && (
                  <div style={{ marginTop: '14px' }}>
                    <div className="kpi-label">
                      Diff Inspector: {selectedWorktreeDiff.branch} ({selectedWorktreeDiff.changedFiles.length}{' '}
                      files changed)
                    </div>
                    <div className="terminal-box" style={{ marginTop: '6px', maxHeight: '220px' }}>
                      {selectedWorktreeDiff.diffPatch ||
                        selectedWorktreeDiff.diffStat ||
                        'Working tree is clean (no uncommitted diff).'}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
