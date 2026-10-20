import {
  AgyCliAdapter,
  AgyModelInfo,
  inferModelFamily,
} from '@agy-client/agy-adapter';

export type DataSourceConfidence = 'officially_reported' | 'estimated_local_budget' | 'unavailable';

export interface SessionUsageSummary {
  conversationId: string;
  title: string;
  workspace: string;
  model: string;
  modelFamily: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requestCount: number;
  stepCount: number;
  durationSeconds: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  parentConversationId: string;
  dataSource: DataSourceConfidence;
}

export interface ModelBudgetConfig {
  family: string;
  windowHours: number;
  maxTokens: number;
  maxRequests: number;
}

export interface ModelQuotaStatus {
  family: string;
  windowHours: number;
  usedTokens: number;
  usedRequests: number;
  maxTokens: number;
  maxRequests: number;
  remainingTokenPercent: number;
  remainingRequestPercent: number;
  tokenDataSource: DataSourceConfidence;
  quotaLimitDataSource: DataSourceConfidence;
  officialCloudQuotaStatus: 'unavailable';
  officialCloudQuotaNote: string;
  lastUpdatedAt: string;
}

export interface UsageAnalyticsSnapshot {
  lastUpdatedAt: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    totalRequests: number;
    totalSessions: number;
    totalDurationSeconds: number;
    dataSource: DataSourceConfidence;
  };
  window5h: {
    totalTokens: number;
    totalRequests: number;
    durationSeconds: number;
  };
  window24h: {
    totalTokens: number;
    totalRequests: number;
    durationSeconds: number;
  };
  byModelFamily: Record<
    string,
    {
      family: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      totalTokens: number;
      requests: number;
      sessions: number;
      durationSeconds: number;
    }
  >;
  quotas: ModelQuotaStatus[];
  sessions: SessionUsageSummary[];
  availableModels: AgyModelInfo[];
}

export const DEFAULT_MODEL_BUDGETS: ModelBudgetConfig[] = [
  {
    family: 'Gemini 4',
    windowHours: 5,
    maxTokens: 2_000_000,
    maxRequests: 250,
  },
  {
    family: 'Gemini 3.8',
    windowHours: 5,
    maxTokens: 5_000_000,
    maxRequests: 500,
  },
  {
    family: 'Claude Opus',
    windowHours: 5,
    maxTokens: 1_000_000,
    maxRequests: 100,
  },
  {
    family: 'Claude Sonnet',
    windowHours: 5,
    maxTokens: 2_000_000,
    maxRequests: 250,
  },
  {
    family: 'GPT-OSS',
    windowHours: 5,
    maxTokens: 3_000_000,
    maxRequests: 300,
  },
];

export class UsageTracker {
  private readonly adapter: AgyCliAdapter;
  private budgets: ModelBudgetConfig[];

  constructor(options?: { adapter?: AgyCliAdapter; budgets?: ModelBudgetConfig[] }) {
    this.adapter = options?.adapter ?? new AgyCliAdapter();
    this.budgets = options?.budgets ?? [...DEFAULT_MODEL_BUDGETS];
  }

  public getBudgets(): ModelBudgetConfig[] {
    return [...this.budgets];
  }

  public setBudgets(budgets: ModelBudgetConfig[]): void {
    this.budgets = [...budgets];
  }

  /**
   * Parses a conversation's `transcript.jsonl` steps into a `SessionUsageSummary`.
   */
  public summarizeConversation(
    conversationId: string,
    meta?: {
      title?: string;
      workspace?: string;
      modelOverride?: string;
      durationSecondsOverride?: number;
      parentConversationId?: string;
    }
  ): SessionUsageSummary {
    const steps = this.adapter.readConversationTranscript(conversationId);
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    const thinkingTokens = 0;
    let requestCount = 0;
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    let detectedModel = meta?.modelOverride || '';

    for (const step of steps) {
      if (step.created_at) {
        if (!firstTs || step.created_at < firstTs) firstTs = step.created_at;
        if (!lastTs || step.created_at > lastTs) lastTs = step.created_at;
      }

      if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
        const modelMatch = /setting `Model Selection` from .* to ([^\n.]+)/i.exec(step.content);
        if (modelMatch && modelMatch[1]) {
          detectedModel = modelMatch[1].trim();
        }
      }

      if (step.type === 'PLANNER_RESPONSE') {
        requestCount += 1;
        inputTokens += Number(step.input_tokens ?? 0);
        outputTokens += Number(step.output_tokens ?? 0);
        cacheReadTokens += Number(step.cache_read_tokens ?? 0);
      }
    }

    const totalTokens = inputTokens + outputTokens + thinkingTokens;
    let durationSeconds = meta?.durationSecondsOverride ?? 0;
    if (!durationSeconds && firstTs && lastTs) {
      const diffMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
      if (diffMs > 0) {
        durationSeconds = Math.round((diffMs / 1000) * 10) / 10;
      }
    }

    const modelName = detectedModel || 'Gemini 4 Argon (Medium)';
    const modelFamily = inferModelFamily(
      modelName.toLowerCase().replace(/\s+/g, '-')
    );

    return {
      conversationId,
      title: meta?.title || `Session ${conversationId.slice(0, 8)}`,
      workspace: meta?.workspace || '',
      model: modelName,
      modelFamily,
      inputTokens,
      outputTokens,
      thinkingTokens,
      cacheReadTokens,
      totalTokens,
      requestCount,
      stepCount: steps.length,
      durationSeconds,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
      parentConversationId: meta?.parentConversationId || '',
      dataSource: 'officially_reported',
    };
  }

  /**
   * Builds a complete usage & quota snapshot combining official CLI transcript data
   * and any in-memory/SQLite sessions tracked by AgyClient.
   */
  public getSnapshot(
    managedSessions: Array<{
      conversationId?: string | null;
      title?: string;
      workspace?: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
      thinkingTokens: number;
      cacheReadTokens: number;
      totalTokens: number;
      turnCount: number;
      durationSeconds: number;
      createdAt: string;
      updatedAt: string;
      parentConversationId?: string;
    }> = []
  ): UsageAnalyticsSnapshot {
    const cliSummaries = this.adapter.listCliConversations(100);
    const cliSummaryMap = new Map(cliSummaries.map((c) => [c.conversationId, c]));
    const brainIds = this.adapter.listBrainConversationIds();

    const allConvIds = new Set<string>([
      ...cliSummaries.map((c) => c.conversationId),
      ...brainIds,
    ]);

    const sessionMap = new Map<string, SessionUsageSummary>();

    for (const convId of allConvIds) {
      const cliMeta = cliSummaryMap.get(convId);
      const summary = this.summarizeConversation(convId, {
        title: cliMeta?.preview || cliMeta?.title || undefined,
        workspace: cliMeta?.workspaceUris?.[0] || '',
        parentConversationId: cliMeta?.parentConversationId || '',
      });
      if (summary.totalTokens > 0 || summary.stepCount > 0 || cliMeta) {
        if (cliMeta && summary.stepCount === 0) {
          summary.stepCount = cliMeta.stepCount;
          summary.lastTimestamp = cliMeta.lastModifiedTime;
        }
        sessionMap.set(convId, summary);
      }
    }

    // Merge managed sessions from AgyClient's database
    for (const ms of managedSessions) {
      const key = ms.conversationId || `managed-${ms.createdAt}`;
      const existing = sessionMap.get(key);
      const model = ms.model || existing?.model || 'gemini-4-argon-medium';
      const family = inferModelFamily(model);

      if (!existing || ms.totalTokens >= existing.totalTokens) {
        sessionMap.set(key, {
          conversationId: key,
          title: ms.title || existing?.title || `Session ${key.slice(0, 8)}`,
          workspace: ms.workspace || existing?.workspace || '',
          model,
          modelFamily: family,
          inputTokens: Math.max(ms.inputTokens, existing?.inputTokens ?? 0),
          outputTokens: Math.max(ms.outputTokens, existing?.outputTokens ?? 0),
          thinkingTokens: Math.max(ms.thinkingTokens, existing?.thinkingTokens ?? 0),
          cacheReadTokens: Math.max(ms.cacheReadTokens, existing?.cacheReadTokens ?? 0),
          totalTokens: Math.max(ms.totalTokens, existing?.totalTokens ?? 0),
          requestCount: Math.max(ms.turnCount, existing?.requestCount ?? 0),
          stepCount: existing?.stepCount ?? ms.turnCount * 2,
          durationSeconds: Math.max(ms.durationSeconds, existing?.durationSeconds ?? 0),
          firstTimestamp: existing?.firstTimestamp ?? ms.createdAt,
          lastTimestamp: ms.updatedAt || existing?.lastTimestamp || ms.createdAt,
          parentConversationId: ms.parentConversationId || existing?.parentConversationId || '',
          dataSource: 'officially_reported',
        });
      }
    }

    const sessions = Array.from(sessionMap.values()).sort((a, b) =>
      (b.lastTimestamp || '').localeCompare(a.lastTimestamp || '')
    );

    const nowMs = Date.now();
    const ms5h = 5 * 3600 * 1000;
    const ms24h = 24 * 3600 * 1000;

    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalRequests: 0,
      totalSessions: sessions.length,
      totalDurationSeconds: 0,
      dataSource: 'officially_reported' as DataSourceConfidence,
    };

    const window5h = { totalTokens: 0, totalRequests: 0, durationSeconds: 0 };
    const window24h = { totalTokens: 0, totalRequests: 0, durationSeconds: 0 };
    const byModelFamily: UsageAnalyticsSnapshot['byModelFamily'] = {};

    for (const s of sessions) {
      totals.inputTokens += s.inputTokens;
      totals.outputTokens += s.outputTokens;
      totals.thinkingTokens += s.thinkingTokens;
      totals.cacheReadTokens += s.cacheReadTokens;
      totals.totalTokens += s.totalTokens;
      totals.totalRequests += s.requestCount;
      totals.totalDurationSeconds += s.durationSeconds;

      if (!byModelFamily[s.modelFamily]) {
        byModelFamily[s.modelFamily] = {
          family: s.modelFamily,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          requests: 0,
          sessions: 0,
          durationSeconds: 0,
        };
      }
      const fam = byModelFamily[s.modelFamily];
      fam.inputTokens += s.inputTokens;
      fam.outputTokens += s.outputTokens;
      fam.cacheReadTokens += s.cacheReadTokens;
      fam.totalTokens += s.totalTokens;
      fam.requests += s.requestCount;
      fam.sessions += 1;
      fam.durationSeconds += s.durationSeconds;

      if (s.lastTimestamp) {
        const tsMs = new Date(s.lastTimestamp).getTime();
        if (!Number.isNaN(tsMs)) {
          const age = nowMs - tsMs;
          if (age <= ms5h) {
            window5h.totalTokens += s.totalTokens;
            window5h.totalRequests += s.requestCount;
            window5h.durationSeconds += s.durationSeconds;
          }
          if (age <= ms24h) {
            window24h.totalTokens += s.totalTokens;
            window24h.totalRequests += s.requestCount;
            window24h.durationSeconds += s.durationSeconds;
          }
        }
      }
    }

    const nowIso = new Date().toISOString();
    const quotas: ModelQuotaStatus[] = this.budgets.map((budget) => {
      const windowMs = budget.windowHours * 3600 * 1000;
      let usedTokens = 0;
      let usedRequests = 0;

      for (const s of sessions) {
        if (s.modelFamily !== budget.family) continue;
        if (s.lastTimestamp) {
          const tsMs = new Date(s.lastTimestamp).getTime();
          if (!Number.isNaN(tsMs) && nowMs - tsMs <= windowMs) {
            usedTokens += s.totalTokens;
            usedRequests += s.requestCount;
          }
        }
      }

      const remainingTokenPct =
        budget.maxTokens > 0
          ? Math.max(0, Math.round(((budget.maxTokens - usedTokens) / budget.maxTokens) * 1000) / 10)
          : 100;
      const remainingReqPct =
        budget.maxRequests > 0
          ? Math.max(0, Math.round(((budget.maxRequests - usedRequests) / budget.maxRequests) * 1000) / 10)
          : 100;

      return {
        family: budget.family,
        windowHours: budget.windowHours,
        usedTokens,
        usedRequests,
        maxTokens: budget.maxTokens,
        maxRequests: budget.maxRequests,
        remainingTokenPercent: remainingTokenPct,
        remainingRequestPercent: remainingReqPct,
        tokenDataSource: 'officially_reported',
        quotaLimitDataSource: 'estimated_local_budget',
        officialCloudQuotaStatus: 'unavailable',
        officialCloudQuotaNote:
          'Token consumption is officially reported by the agy CLI (stream-json & transcript.jsonl). Upstream Google Cloud server-side quota ceilings are not exposed by agy v1.4.3; percentage bars reflect your configured local rolling-window budget.',
        lastUpdatedAt: nowIso,
      };
    });

    return {
      lastUpdatedAt: nowIso,
      totals,
      window5h,
      window24h,
      byModelFamily,
      quotas,
      sessions,
      availableModels: AgyCliAdapter.getFallbackModels(),
    };
  }
}
