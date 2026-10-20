import React, { useState, useMemo } from 'react';

interface SessionUsageItem {
  conversationId: string;
  title: string;
  workspace: string;
  model: string;
  modelFamily?: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requestCount: number;
  stepCount?: number;
  durationSeconds: number;
  firstTimestamp?: string | null;
  lastTimestamp?: string | null;
  parentConversationId?: string;
}

interface ModelQuotaItem {
  family: string;
  windowHours: number;
  usedTokens: number;
  usedRequests: number;
  maxTokens: number;
  maxRequests: number;
  remainingTokenPercent: number;
  remainingRequestPercent: number;
}

const FAMILY_COLORS: Record<string, string> = {
  'Gemini 4': '#3b82f6',
  'Gemini 3.8': '#06b6d4',
  'Claude Opus': '#8b5cf6',
  'Claude Sonnet': '#ec4899',
  'GPT-OSS': '#10b981',
  Other: '#f59e0b',
};

function getFamilyColor(family: string, index = 0): string {
  if (FAMILY_COLORS[family]) return FAMILY_COLORS[family];
  const palette = ['#3b82f6', '#06b6d4', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899'];
  return palette[index % palette.length];
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180.0;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const clampedEnd = Math.min(endAngle, startAngle + 359.99);
  const start = polarToCartesian(cx, cy, r, clampedEnd);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = clampedEnd - startAngle <= 180 ? '0' : '1';
  return ['M', start.x, start.y, 'A', r, r, 0, largeArcFlag, 0, end.x, end.y].join(' ');
}

export function TokenActivityAreaChart({
  sessions,
  height = 210,
}: {
  sessions: SessionUsageItem[];
  height?: number;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const points = useMemo(() => {
    const sorted = [...sessions]
      .filter((s) => s.totalTokens > 0 || s.requestCount > 0)
      .sort((a, b) =>
        (a.lastTimestamp || a.firstTimestamp || '').localeCompare(
          b.lastTimestamp || b.firstTimestamp || ''
        )
      )
      .slice(-16);

    if (sorted.length === 0) return [];
    let cumulative = 0;
    return sorted.map((s, idx) => {
      cumulative += s.totalTokens;
      return {
        idx,
        id: s.conversationId,
        label: s.title || s.conversationId.slice(0, 8),
        shortTime: s.lastTimestamp
          ? new Date(s.lastTimestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
          : `#${idx + 1}`,
        input: s.inputTokens,
        output: s.outputTokens,
        cache: s.cacheReadTokens,
        total: s.totalTokens,
        turns: s.requestCount,
        duration: s.durationSeconds,
        cumulative,
        model: s.model,
      };
    });
  }, [sessions]);

  if (points.length === 0) {
    return (
      <div className="chart-empty">
        No token telemetry recorded yet. Launch an agent session to populate the live curve.
      </div>
    );
  }

  const width = 640;
  const padLeft = 52;
  const padRight = 20;
  const padTop = 22;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const maxTotal = Math.max(100, ...points.map((p) => p.total));
  const xFor = (i: number) =>
    points.length === 1 ? padLeft + plotW / 2 : padLeft + (i / (points.length - 1)) * plotW;
  const yFor = (val: number) => padTop + plotH - (val / maxTotal) * plotH;

  // Build smooth cubic bezier path
  const coords = points.map((p, i) => ({ x: xFor(i), y: yFor(p.total), inputY: yFor(p.input) }));

  const buildSmoothPath = (pts: Array<{ x: number; y: number }>) => {
    if (pts.length === 1) {
      return `M ${padLeft} ${pts[0].y} L ${padLeft + plotW} ${pts[0].y}`;
    }
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const cpx1 = p0.x + (p1.x - p0.x) * 0.45;
      const cpy1 = p0.y;
      const cpx2 = p0.x + (p1.x - p0.x) * 0.55;
      const cpy2 = p1.y;
      d += ` C ${cpx1} ${cpy1}, ${cpx2} ${cpy2}, ${p1.x} ${p1.y}`;
    }
    return d;
  };

  const totalLinePath = buildSmoothPath(coords);
  const totalAreaPath =
    coords.length === 1
      ? `${totalLinePath} L ${padLeft + plotW} ${padTop + plotH} L ${padLeft} ${padTop + plotH} Z`
      : `${totalLinePath} L ${coords[coords.length - 1].x} ${padTop + plotH} L ${coords[0].x} ${
          padTop + plotH
        } Z`;

  const inputPts = coords.map((c) => ({ x: c.x, y: c.inputY }));
  const inputLinePath = buildSmoothPath(inputPts);
  const inputAreaPath =
    inputPts.length === 1
      ? `${inputLinePath} L ${padLeft + plotW} ${padTop + plotH} L ${padLeft} ${padTop + plotH} Z`
      : `${inputLinePath} L ${inputPts[inputPts.length - 1].x} ${padTop + plotH} L ${
          inputPts[0].x
        } ${padTop + plotH} Z`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    val: Math.round(maxTotal * t),
    y: yFor(maxTotal * t),
  }));

  const activePoint = hoveredIdx !== null ? points[hoveredIdx] : points[points.length - 1];

  return (
    <div className="chart-container">
      <div className="chart-legend-bar">
        <div style={{ display: 'flex', gap: '14px', alignItems: 'center', fontSize: '0.76rem' }}>
          <span className="legend-dot" style={{ '--dot-color': '#3b82f6' } as React.CSSProperties}>
            Total Session Tokens
          </span>
          <span className="legend-dot" style={{ '--dot-color': '#10b981' } as React.CSSProperties}>
            Input Tokens
          </span>
        </div>
        {activePoint && (
          <div className="chart-active-pill">
            <strong>{activePoint.label.slice(0, 28)}</strong>:{' '}
            <span style={{ color: '#60a5fa' }}>{activePoint.total.toLocaleString()} tok</span> (
            {activePoint.input.toLocaleString()} in / {activePoint.output.toLocaleString()} out |{' '}
            {activePoint.duration.toFixed(1)}s)
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="svg-chart"
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <defs>
          <linearGradient id="agyTotalGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="agyInputGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {yTicks.map((t, idx) => (
          <g key={idx}>
            <line
              x1={padLeft}
              y1={t.y}
              x2={width - padRight}
              y2={t.y}
              stroke="#1e293b"
              strokeDasharray={idx === 0 ? undefined : '4 4'}
            />
            <text
              x={padLeft - 8}
              y={t.y + 4}
              textAnchor="end"
              fill="#64748b"
              fontSize="10"
            >
              {t.val >= 1000 ? `${(t.val / 1000).toFixed(1)}k` : t.val}
            </text>
          </g>
        ))}

        <path d={totalAreaPath} fill="url(#agyTotalGrad)" />
        <path d={inputAreaPath} fill="url(#agyInputGrad)" />
        <path d={inputLinePath} fill="none" stroke="#10b981" strokeWidth="2" strokeDasharray="3 2" />
        <path d={totalLinePath} fill="none" stroke="#3b82f6" strokeWidth="2.6" />

        {coords.map((c, i) => {
          const isHover = hoveredIdx === i;
          return (
            <g
              key={points[i].id}
              onMouseEnter={() => setHoveredIdx(i)}
              style={{ cursor: 'pointer' }}
            >
              {isHover && (
                <line
                  x1={c.x}
                  y1={padTop}
                  x2={c.x}
                  y2={padTop + plotH}
                  stroke="#60a5fa"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
              )}
              <circle
                cx={c.x}
                cy={c.y}
                r={isHover ? 6 : 4}
                fill={isHover ? '#60a5fa' : '#0f172a'}
                stroke="#3b82f6"
                strokeWidth="2.2"
              />
              {(i % Math.max(1, Math.floor(points.length / 6)) === 0 ||
                i === points.length - 1) && (
                <text
                  x={c.x}
                  y={height - 10}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="10"
                >
                  {points[i].shortTime}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function ModelDistributionDonutChart({
  byModelFamily,
}: {
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
}) {
  const [hoveredFamily, setHoveredFamily] = useState<string | null>(null);

  const entries = useMemo(() => {
    const list = Object.values(byModelFamily || {}).filter(
      (f) => f.totalTokens > 0 || f.sessions > 0
    );
    return list.sort((a, b) => b.totalTokens - a.totalTokens);
  }, [byModelFamily]);

  const grandTotal = entries.reduce((acc, e) => acc + Math.max(1, e.totalTokens), 0);

  if (entries.length === 0) {
    return (
      <div className="chart-empty">
        No model distribution data yet. Run a session to see model family shares.
      </div>
    );
  }

  let currentAngle = 0;
  const slices = entries.map((entry, idx) => {
    const value = Math.max(1, entry.totalTokens);
    const angle = (value / grandTotal) * 360;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    currentAngle = endAngle;
    return {
      ...entry,
      color: getFamilyColor(entry.family, idx),
      percent: Math.round((entry.totalTokens / Math.max(1, grandTotal)) * 1000) / 10,
      startAngle,
      endAngle,
    };
  });

  const activeSlice =
    slices.find((s) => s.family === hoveredFamily) || slices[0];

  return (
    <div className="donut-layout">
      <svg viewBox="0 0 200 200" width="175" height="175" style={{ flexShrink: 0 }}>
        <circle
          cx="100"
          cy="100"
          r="70"
          fill="none"
          stroke="#1e293b"
          strokeWidth="22"
        />
        {slices.map((s) => {
          const isHovered = hoveredFamily === s.family;
          return (
            <path
              key={s.family}
              d={describeArc(100, 100, 70, s.startAngle, s.endAngle)}
              fill="none"
              stroke={s.color}
              strokeWidth={isHovered ? 26 : 22}
              strokeLinecap="butt"
              style={{ cursor: 'pointer', transition: 'stroke-width 0.15s ease' }}
              onMouseEnter={() => setHoveredFamily(s.family)}
              onMouseLeave={() => setHoveredFamily(null)}
            />
          );
        })}
        <text
          x="100"
          y="93"
          textAnchor="middle"
          fill="#f1f5f9"
          fontSize="13"
          fontWeight="700"
        >
          {activeSlice.family}
        </text>
        <text
          x="100"
          y="112"
          textAnchor="middle"
          fill="#93c5fd"
          fontSize="12"
          fontWeight="600"
        >
          {activeSlice.totalTokens.toLocaleString()} tok
        </text>
        <text x="100" y="127" textAnchor="middle" fill="#64748b" fontSize="10">
          {activeSlice.sessions} sess • {activeSlice.requests} turns
        </text>
      </svg>

      <div className="donut-legend">
        {slices.map((s) => (
          <div
            key={s.family}
            className="donut-legend-row"
            onMouseEnter={() => setHoveredFamily(s.family)}
            onMouseLeave={() => setHoveredFamily(null)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: s.color,
                  display: 'inline-block',
                }}
              />
              <strong>{s.family}</strong>
            </div>
            <div style={{ color: '#94a3b8', fontSize: '0.78rem' }}>
              {s.totalTokens.toLocaleString()} ({s.percent}%)
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function QuotaRadialGauge({ quota }: { quota: ModelQuotaItem }) {
  const usedPct = Math.min(100, Math.max(0, 100 - quota.remainingTokenPercent));
  const reqUsedPct = Math.min(100, Math.max(0, 100 - quota.remainingRequestPercent));
  const color =
    usedPct > 85 ? '#ef4444' : usedPct > 60 ? '#f59e0b' : getFamilyColor(quota.family);

  // Semi-circle gauge from -110 deg to +110 deg
  const startDeg = -110;
  const sweepDeg = 220;
  const endDeg = startDeg + (usedPct / 100) * sweepDeg;

  return (
    <div className="gauge-card">
      <svg viewBox="0 0 180 122" width="165" height="112">
        <path
          d={describeArc(90, 92, 66, startDeg, startDeg + sweepDeg)}
          fill="none"
          stroke="#1e293b"
          strokeWidth="14"
          strokeLinecap="round"
        />
        {usedPct > 0.2 && (
          <path
            d={describeArc(90, 92, 66, startDeg, endDeg)}
            fill="none"
            stroke={color}
            strokeWidth="14"
            strokeLinecap="round"
          />
        )}
        <text
          x="90"
          y="78"
          textAnchor="middle"
          fill="#f1f5f9"
          fontSize="18"
          fontWeight="700"
        >
          {quota.remainingTokenPercent}%
        </text>
        <text x="90" y="96" textAnchor="middle" fill="#94a3b8" fontSize="10">
          Budget Remaining
        </text>
      </svg>
      <div style={{ textAlign: 'center', width: '100%' }}>
        <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{quota.family}</div>
        <div style={{ fontSize: '0.74rem', color: '#94a3b8', marginTop: '2px' }}>
          {quota.usedTokens.toLocaleString()} / {(quota.maxTokens / 1_000_000).toFixed(1)}M tok (
          {quota.windowHours}h)
        </div>
        <div style={{ fontSize: '0.72rem', color: '#60a5fa', marginTop: '2px' }}>
          Requests: {quota.usedRequests}/{quota.maxRequests} ({reqUsedPct.toFixed(1)}% used)
        </div>
      </div>
    </div>
  );
}

export function TokenCompositionStackedBars({
  sessions,
}: {
  sessions: SessionUsageItem[];
}) {
  const topSessions = useMemo(() => {
    return [...sessions]
      .filter((s) => s.totalTokens > 0 || s.cacheReadTokens > 0)
      .slice(0, 7);
  }, [sessions]);

  if (topSessions.length === 0) {
    return (
      <div className="chart-empty">
        No session token composition available yet.
      </div>
    );
  }

  const maxBar = Math.max(
    1,
    ...topSessions.map((s) => s.inputTokens + s.outputTokens + s.cacheReadTokens)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', gap: '14px', fontSize: '0.75rem', color: '#94a3b8' }}>
        <span className="legend-dot" style={{ '--dot-color': '#3b82f6' } as React.CSSProperties}>
          Input Tokens
        </span>
        <span className="legend-dot" style={{ '--dot-color': '#8b5cf6' } as React.CSSProperties}>
          Cache Read Tokens
        </span>
        <span className="legend-dot" style={{ '--dot-color': '#10b981' } as React.CSSProperties}>
          Output Tokens
        </span>
      </div>

      {topSessions.map((s) => {
        const combined = Math.max(1, s.inputTokens + s.outputTokens + s.cacheReadTokens);
        const inPct = (s.inputTokens / maxBar) * 100;
        const cachePct = (s.cacheReadTokens / maxBar) * 100;
        const outPct = (s.outputTokens / maxBar) * 100;

        return (
          <div key={s.conversationId} className="stacked-bar-row">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '0.78rem',
                marginBottom: '4px',
              }}
            >
              <span style={{ fontWeight: 600 }}>
                {s.title.slice(0, 36)} <code style={{ color: '#64748b' }}>({s.model})</code>
              </span>
              <span style={{ color: '#94a3b8' }}>
                {combined.toLocaleString()} tok • {s.durationSeconds.toFixed(1)}s
              </span>
            </div>
            <div className="stacked-bar-track">
              <div
                style={{ width: `${inPct}%`, background: '#3b82f6' }}
                title={`Input: ${s.inputTokens.toLocaleString()}`}
              />
              <div
                style={{ width: `${cachePct}%`, background: '#8b5cf6' }}
                title={`Cache Read: ${s.cacheReadTokens.toLocaleString()}`}
              />
              <div
                style={{ width: `${outPct}%`, background: '#10b981' }}
                title={`Output: ${s.outputTokens.toLocaleString()}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function WorkflowDagGraph({
  tasks,
  title,
}: {
  tasks: Array<{
    id: string;
    name: string;
    role?: string;
    strategy: string;
    dependsOn: string[];
    status?: string;
    model?: string;
  }>;
  title?: string;
}) {
  const layout = useMemo(() => {
    if (!tasks || tasks.length === 0) return { nodes: [], edges: [], width: 520, height: 150 };

    const depthMap = new Map<string, number>();
    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    const getDepth = (id: string, visited = new Set<string>()): number => {
      if (depthMap.has(id)) return depthMap.get(id)!;
      if (visited.has(id)) return 0;
      visited.add(id);
      const t = taskMap.get(id);
      if (!t || !t.dependsOn || t.dependsOn.length === 0) {
        depthMap.set(id, 0);
        return 0;
      }
      const maxParent = Math.max(
        0,
        ...t.dependsOn.map((d) => (taskMap.has(d) ? getDepth(d, new Set(visited)) + 1 : 0))
      );
      depthMap.set(id, maxParent);
      return maxParent;
    };

    tasks.forEach((t) => getDepth(t.id));

    const columns = new Map<number, typeof tasks>();
    let maxCol = 0;
    for (const t of tasks) {
      const d = depthMap.get(t.id) || 0;
      maxCol = Math.max(maxCol, d);
      if (!columns.has(d)) columns.set(d, []);
      columns.get(d)!.push(t);
    }

    const nodeW = 165;
    const nodeH = 58;
    const colGap = 58;
    const rowGap = 24;

    const maxRows = Math.max(1, ...Array.from(columns.values()).map((c) => c.length));
    const width = Math.max(540, (maxCol + 1) * (nodeW + colGap) + 20);
    const height = Math.max(145, maxRows * (nodeH + rowGap) + 30);

    const posMap = new Map<string, { x: number; y: number; task: (typeof tasks)[0] }>();

    for (let col = 0; col <= maxCol; col++) {
      const colTasks = columns.get(col) || [];
      const totalColH = colTasks.length * nodeH + Math.max(0, colTasks.length - 1) * rowGap;
      const startY = (height - totalColH) / 2;
      colTasks.forEach((t, rowIdx) => {
        const x = 20 + col * (nodeW + colGap);
        const y = startY + rowIdx * (nodeH + rowGap);
        posMap.set(t.id, { x, y, task: t });
      });
    }

    const edges: Array<{ from: string; to: string; path: string; active: boolean }> = [];
    for (const t of tasks) {
      const target = posMap.get(t.id);
      if (!target) continue;
      for (const depId of t.dependsOn || []) {
        const source = posMap.get(depId);
        if (!source) continue;
        const x1 = source.x + nodeW;
        const y1 = source.y + nodeH / 2;
        const x2 = target.x;
        const y2 = target.y + nodeH / 2;
        const cpx1 = x1 + (x2 - x1) * 0.5;
        const cpx2 = x1 + (x2 - x1) * 0.5;
        edges.push({
          from: depId,
          to: t.id,
          path: `M ${x1} ${y1} C ${cpx1} ${y1}, ${cpx2} ${y2}, ${x2} ${y2}`,
          active: source.task.status === 'completed' || target.task.status === 'running',
        });
      }
    }

    return {
      nodes: Array.from(posMap.values()),
      edges,
      width,
      height,
      nodeW,
      nodeH,
    };
  }, [tasks]);

  const statusColor = (status?: string) => {
    switch (status) {
      case 'completed':
        return { stroke: '#10b981', fill: 'rgba(16, 185, 129, 0.14)', text: '#6ee7b7' };
      case 'running':
        return { stroke: '#3b82f6', fill: 'rgba(59, 130, 246, 0.18)', text: '#93c5fd' };
      case 'failed':
        return { stroke: '#ef4444', fill: 'rgba(239, 68, 68, 0.16)', text: '#fca5a5' };
      default:
        return { stroke: '#334155', fill: '#0f172a', text: '#cbd5e1' };
    }
  };

  return (
    <div className="dag-graph-box">
      {title && (
        <div style={{ fontSize: '0.76rem', color: '#94a3b8', marginBottom: '6px', fontWeight: 600 }}>
          {title}
        </div>
      )}
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="svg-chart">
        <defs>
          <marker
            id="dagArrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#60a5fa" />
          </marker>
        </defs>

        {layout.edges.map((e) => (
          <path
            key={`${e.from}->${e.to}`}
            d={e.path}
            fill="none"
            stroke={e.active ? '#3b82f6' : '#475569'}
            strokeWidth={e.active ? '2.4' : '1.8'}
            strokeDasharray={e.active ? undefined : '4 3'}
            markerEnd="url(#dagArrow)"
          />
        ))}

        {layout.nodes.map(({ x, y, task }) => {
          const st = statusColor(task.status);
          return (
            <g key={task.id} transform={`translate(${x}, ${y})`}>
              <rect
                width={layout.nodeW}
                height={layout.nodeH}
                rx="8"
                fill={st.fill}
                stroke={st.stroke}
                strokeWidth="1.8"
              />
              <text
                x="10"
                y="21"
                fill="#f8fafc"
                fontSize="11"
                fontWeight="700"
              >
                {task.name.length > 21 ? `${task.name.slice(0, 20)}…` : task.name}
              </text>
              <text x="10" y="37" fill="#94a3b8" fontSize="9.5">
                {task.strategy === 'subagent' ? 'Subagent Delegation' : 'Independent Process'}
              </text>
              <text x="10" y="50" fill={st.text} fontSize="9" fontWeight="600">
                {(task.status || task.role || 'ready').toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function ConcurrencySwimlaneGantt({
  sessions,
}: {
  sessions: Array<{
    id: string;
    title: string;
    status: string;
    model: string;
    durationSeconds: number;
    totalTokens: number;
    createdAt: string;
    updatedAt: string;
    branchName?: string | null;
  }>;
}) {
  const recent = useMemo(() => sessions.slice(0, 8), [sessions]);

  if (recent.length === 0) {
    return (
      <div className="chart-empty">
        No parallel agent processes launched yet.
      </div>
    );
  }

  const maxDur = Math.max(5, ...recent.map((s) => s.durationSeconds || 1));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {recent.map((s) => {
        const widthPct = Math.max(8, Math.min(100, ((s.durationSeconds || 1) / maxDur) * 100));
        const barColor =
          s.status === 'running' || s.status === 'starting'
            ? 'linear-gradient(90deg, #3b82f6, #60a5fa)'
            : s.status === 'completed'
            ? 'linear-gradient(90deg, #059669, #10b981)'
            : s.status === 'failed'
            ? 'linear-gradient(90deg, #dc2626, #ef4444)'
            : '#475569';

        return (
          <div key={s.id} className="swimlane-row">
            <div className="swimlane-meta">
              <strong style={{ fontSize: '0.8rem' }}>{s.title.slice(0, 28)}</strong>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                {s.durationSeconds.toFixed(1)}s • {s.totalTokens.toLocaleString()} tok
              </span>
            </div>
            <div className="swimlane-track">
              <div
                className={`swimlane-bar ${
                  s.status === 'running' || s.status === 'starting' ? 'pulse-bar' : ''
                }`}
                style={{ width: `${widthPct}%`, background: barColor }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SecurityDefenseDonut({
  allowCount,
  askCount,
  denyCount,
  protectedProjectsCount,
}: {
  allowCount: number;
  askCount: number;
  denyCount: number;
  protectedProjectsCount: number;
}) {
  const total = Math.max(1, allowCount + askCount + denyCount);
  const allowDeg = (allowCount / total) * 360;
  const askDeg = (askCount / total) * 360;
  const denyDeg = (denyCount / total) * 360;

  return (
    <div className="donut-layout" style={{ alignItems: 'center' }}>
      <svg viewBox="0 0 160 160" width="135" height="135">
        <circle cx="80" cy="80" r="54" fill="none" stroke="#1e293b" strokeWidth="18" />
        {allowCount > 0 && (
          <path
            d={describeArc(80, 80, 54, 0, allowDeg)}
            fill="none"
            stroke="#10b981"
            strokeWidth="18"
          />
        )}
        {askCount > 0 && (
          <path
            d={describeArc(80, 80, 54, allowDeg, allowDeg + askDeg)}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="18"
          />
        )}
        {denyCount > 0 && (
          <path
            d={describeArc(80, 80, 54, allowDeg + askDeg, allowDeg + askDeg + denyDeg)}
            fill="none"
            stroke="#ef4444"
            strokeWidth="18"
          />
        )}
        <text x="80" y="76" textAnchor="middle" fill="#f1f5f9" fontSize="16" fontWeight="700">
          {allowCount + askCount + denyCount}
        </text>
        <text x="80" y="94" textAnchor="middle" fill="#94a3b8" fontSize="9.5">
          Active Rules
        </text>
      </svg>

      <div className="donut-legend">
        <div className="donut-legend-row">
          <span className="badge badge-deny">DENY (Strict Block)</span>
          <strong>{denyCount} rules</strong>
        </div>
        <div className="donut-legend-row">
          <span className="badge badge-ask">ASK (Confirmation)</span>
          <strong>{askCount} rules</strong>
        </div>
        <div className="donut-legend-row">
          <span className="badge badge-allow">ALLOW (Routine)</span>
          <strong>{allowCount} rules</strong>
        </div>
        <div className="donut-legend-row">
          <span className="badge badge-running">NTFS ACL Locked</span>
          <strong>{protectedProjectsCount} workspaces</strong>
        </div>
      </div>
    </div>
  );
}
