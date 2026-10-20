import React, { useState, useMemo, useRef, useEffect } from 'react';

export interface AgentLogEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'system' | 'agent' | 'tool';
  text: string;
  rawEvent?: {
    event?: string;
    conversation_id?: string;
    init?: {
      model?: string;
      cwd?: string;
      tools?: string[];
      permission_mode?: string;
    };
    step_update?: {
      conversation_id?: string;
      step_index?: number;
      state?: string;
      step_type?: string;
      text_delta?: string;
      tool_name?: string;
      tool_args?: Record<string, unknown>;
      duration_seconds?: number;
    };
    result?: {
      conversation_id?: string;
      status?: string;
      response?: string;
      duration_seconds?: number;
      num_turns?: number;
    };
    [key: string]: unknown;
  };
}

export interface ToolExecutionItem {
  id: string;
  toolName: string;
  state: 'ACTIVE' | 'DONE' | 'ERROR' | string;
  stepIndex?: number;
  args?: Record<string, unknown>;
  durationSeconds?: number;
  timestamp: string;
}

export type CoalescedConversationItem =
  | {
      kind: 'user_prompt';
      id: string;
      prompt: string;
      commandLine: string;
      timestamp: string;
    }
  | {
      kind: 'system_init';
      id: string;
      conversationId?: string;
      permissionMode?: string;
      model?: string;
      toolCount?: number;
      text: string;
      timestamp: string;
    }
  | {
      kind: 'tool_group';
      id: string;
      tools: ToolExecutionItem[];
      timestamp: string;
    }
  | {
      kind: 'agent_response';
      id: string;
      markdown: string;
      isStreaming: boolean;
      durationSeconds?: number;
      completionSummary?: string;
      timestamp: string;
    }
  | {
      kind: 'notice';
      id: string;
      level: 'info' | 'warning' | 'error';
      text: string;
      timestamp: string;
    };

/**
 * Extracts the prompt string from a `Launching: agy ... --print "..."` system log line.
 */
function extractPromptFromLaunchLog(text: string): string | null {
  const printMatch = /--print\s+(?:"([\s\S]*)"|(\S+))$/.exec(text.trim());
  if (printMatch) {
    return (printMatch[1] ?? printMatch[2] ?? '').trim();
  }
  return null;
}

/**
 * Coalesces raw streaming log chunks (`step_update` deltas, duplicate `result` events,
 * and `Tool [name] (ACTIVE/DONE)` pairs) into clean structured conversation items.
 */
export function coalesceSessionLogs(
  logs: AgentLogEntry[],
  options?: {
    fallbackPrompt?: string;
    lastResponse?: string;
    sessionStatus?: string;
  }
): CoalescedConversationItem[] {
  const items: CoalescedConversationItem[] = [];
  const isSessionActive =
    options?.sessionStatus === 'running' || options?.sessionStatus === 'starting';

  for (const entry of logs) {
    const raw = entry.rawEvent;

    // 1. System logs: Launching command, Session initialized, Turn completed, etc.
    if (entry.stream === 'system') {
      if (entry.text.startsWith('Launching:')) {
        const extractedPrompt =
          extractPromptFromLaunchLog(entry.text) || options?.fallbackPrompt || entry.text;
        items.push({
          kind: 'user_prompt',
          id: entry.id,
          prompt: extractedPrompt,
          commandLine: entry.text,
          timestamp: entry.timestamp,
        });
        continue;
      }

      if (raw?.event === 'init' || entry.text.startsWith('Session initialized')) {
        items.push({
          kind: 'system_init',
          id: entry.id,
          conversationId: raw?.conversation_id,
          permissionMode: raw?.init?.permission_mode,
          model: raw?.init?.model,
          toolCount: Array.isArray(raw?.init?.tools) ? raw?.init?.tools.length : undefined,
          text: entry.text,
          timestamp: entry.timestamp,
        });
        continue;
      }

      if (entry.text.startsWith('Turn completed in')) {
        // Attach completion summary to the most recent agent_response if available
        let attached = false;
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i];
          if (item.kind === 'agent_response') {
            item.completionSummary = entry.text;
            item.isStreaming = false;
            attached = true;
            break;
          }
          if (item.kind === 'user_prompt') break;
        }
        if (!attached) {
          items.push({
            kind: 'notice',
            id: entry.id,
            level: 'info',
            text: entry.text,
            timestamp: entry.timestamp,
          });
        }
        continue;
      }

      items.push({
        kind: 'notice',
        id: entry.id,
        level: 'info',
        text: entry.text,
        timestamp: entry.timestamp,
      });
      continue;
    }

    // 2. Stderr warnings / errors
    if (entry.stream === 'stderr') {
      const isWarning = /^warning:/i.test(entry.text.trim());
      items.push({
        kind: 'notice',
        id: entry.id,
        level: isWarning ? 'warning' : 'error',
        text: entry.text,
        timestamp: entry.timestamp,
      });
      continue;
    }

    // 3. Tool calls: group consecutive tool updates and pair ACTIVE -> DONE
    if (entry.stream === 'tool') {
      const su = raw?.step_update;
      const parsedMatch = /^Tool \[([^\]]+)\]\s*\(([^)]+)\)/.exec(entry.text);
      const toolName = su?.tool_name || (parsedMatch ? parsedMatch[1] : 'tool');
      const toolState = su?.state || (parsedMatch ? parsedMatch[2] : 'DONE');
      const stepIndex = su?.step_index;

      let group = items[items.length - 1];
      // Look past trailing system_init or warning notices if a tool_group is right before them
      if (!group || group.kind !== 'tool_group') {
        group = {
          kind: 'tool_group',
          id: `tg-${entry.id}`,
          tools: [],
          timestamp: entry.timestamp,
        };
        items.push(group);
      }

      // Check if there is an existing ACTIVE tool entry we can update to DONE
      const existingIdx = group.tools.findIndex(
        (t) =>
          (stepIndex !== undefined && t.stepIndex === stepIndex) ||
          (t.toolName === toolName && t.state === 'ACTIVE')
      );

      if (existingIdx !== -1) {
        group.tools[existingIdx] = {
          ...group.tools[existingIdx],
          state: toolState,
          args: su?.tool_args || group.tools[existingIdx].args,
          durationSeconds: su?.duration_seconds ?? group.tools[existingIdx].durationSeconds,
        };
      } else {
        group.tools.push({
          id: entry.id,
          toolName,
          state: toolState,
          stepIndex,
          args: su?.tool_args,
          durationSeconds: su?.duration_seconds,
          timestamp: entry.timestamp,
        });
      }
      continue;
    }

    // 4. Agent response stream or final result
    if (entry.stream === 'agent' || entry.stream === 'stdout') {
      const isResultEvent = raw?.event === 'result';
      const stepState = raw?.step_update?.state;
      const chunkText = isResultEvent
        ? raw?.result?.response || entry.text
        : raw?.step_update?.text_delta ?? entry.text;

      // Find the current turn's active agent_response (after the last user_prompt)
      let currentResponse: Extract<CoalescedConversationItem, { kind: 'agent_response' }> | null =
        null;
      for (let i = items.length - 1; i >= 0; i--) {
        const candidate = items[i];
        if (candidate.kind === 'user_prompt') break;
        if (candidate.kind === 'agent_response') {
          currentResponse = candidate;
          break;
        }
      }

      if (isResultEvent) {
        // The `result` event contains the complete, authoritative final response for the turn.
        // Replace the delta-accumulated text instead of duplicating it!
        if (currentResponse) {
          if (chunkText && chunkText.trim().length >= currentResponse.markdown.trim().length * 0.5) {
            currentResponse.markdown = chunkText;
          }
          currentResponse.isStreaming = false;
          currentResponse.durationSeconds =
            raw?.result?.duration_seconds ?? currentResponse.durationSeconds;
        } else if (chunkText.trim()) {
          items.push({
            kind: 'agent_response',
            id: entry.id,
            markdown: chunkText,
            isStreaming: false,
            durationSeconds: raw?.result?.duration_seconds,
            timestamp: entry.timestamp,
          });
        }
        continue;
      }

      // Heuristic deduplication for historical logs where `rawEvent` might not be populated
      // and the final `result` entry repeats the entire accumulated response
      if (
        currentResponse &&
        chunkText.length > 60 &&
        currentResponse.markdown.length > 40 &&
        chunkText.trim().slice(0, 40) === currentResponse.markdown.trim().slice(0, 40)
      ) {
        currentResponse.markdown = chunkText;
        currentResponse.isStreaming = false;
        continue;
      }

      if (currentResponse) {
        currentResponse.markdown += chunkText;
        if (stepState === 'DONE') {
          currentResponse.isStreaming = false;
          if (raw?.step_update?.duration_seconds) {
            currentResponse.durationSeconds = raw.step_update.duration_seconds;
          }
        }
      } else {
        items.push({
          kind: 'agent_response',
          id: entry.id,
          markdown: chunkText,
          isStreaming: isSessionActive && stepState !== 'DONE',
          durationSeconds: raw?.step_update?.duration_seconds,
          timestamp: entry.timestamp,
        });
      }
    }
  }

  // Ensure that if the session has a fuller `lastResponse` (e.g., if log rows were capped at 300 in DB),
  // the last agent_response reflects the complete `lastResponse`.
  if (options?.lastResponse && options.lastResponse.trim()) {
    const cleanLast = options.lastResponse.trim();
    let lastAgentItem: Extract<CoalescedConversationItem, { kind: 'agent_response' }> | null = null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'agent_response') {
        lastAgentItem = it;
        break;
      }
    }

    if (!lastAgentItem) {
      if (options.fallbackPrompt && !items.some((x) => x.kind === 'user_prompt')) {
        items.unshift({
          kind: 'user_prompt',
          id: 'fallback-prompt',
          prompt: options.fallbackPrompt,
          commandLine: '',
          timestamp: new Date().toISOString(),
        });
      }
      items.push({
        kind: 'agent_response',
        id: 'fallback-last-response',
        markdown: cleanLast,
        isStreaming: false,
        timestamp: new Date().toISOString(),
      });
    } else if (
      !isSessionActive &&
      cleanLast.length > lastAgentItem.markdown.trim().length &&
      cleanLast.slice(0, 25) === lastAgentItem.markdown.trim().slice(0, 25)
    ) {
      lastAgentItem.markdown = cleanLast;
      lastAgentItem.isStreaming = false;
    }
  }

  if (!isSessionActive) {
    for (const item of items) {
      if (item.kind === 'agent_response') {
        item.isStreaming = false;
      }
    }
  }

  return items;
}

/**
 * Formats a `file:///...` URI into a readable path and optional line range.
 */
function parseFileUri(uri: string): {
  fullPath: string;
  displayPath: string;
  lineRange: string | null;
} {
  try {
    const [withoutHash, hash] = uri.split('#');
    const decoded = decodeURIComponent(withoutHash.replace(/^file:\/\/\/?/, ''));
    const normalized = decoded.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const shortParts = parts.slice(-2).join('/');
    return {
      fullPath: decoded + (hash ? `#${hash}` : ''),
      displayPath: shortParts || decoded,
      lineRange: hash || null,
    };
  } catch {
    return { fullPath: uri, displayPath: uri, lineRange: null };
  }
}

/**
 * Replaces common inline LaTeX math symbols (e.g. `$\rightarrow$`) with clean Unicode equivalents.
 */
function normalizePlainSegment(text: string): string {
  return text
    .replace(/\$\\(?:rightarrow|to)\$/g, '→')
    .replace(/\$\\leftarrow\$/g, '←')
    .replace(/\$\\leftrightarrow\$/g, '↔')
    .replace(/\$\\Rightarrow\$/g, '⇒')
    .replace(/\$\\(?:ge|geq)\$/g, '≥')
    .replace(/\$\\(?:le|leq)\$/g, '≤')
    .replace(/\$\\times\$/g, '×');
}

/**
 * Separates leading intermediate status updates (e.g. "Waiting for it to finish...",
 * "Running the full build... now...") from the authoritative final summary.
 */
export function splitInterimStatusUpdates(content: string): {
  interimUpdates: string[];
  mainContent: string;
} {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return { interimUpdates: [], mainContent: '' };
  }

  const lines = normalized.split('\n');
  const interimUpdates: string[] = [];
  let idx = 0;

  const isInterimLine = (line: string): boolean => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('-') || t.startsWith('*') || /^\d+\./.test(t)) {
      return false;
    }
    return (
      /\bwaiting for\b.*\b(?:finish|complete)/i.test(t) ||
      /\bwill (?:report back|update you)\b/i.test(t) ||
      /\bbefore summarizing\b/i.test(t) ||
      /\b(?:running|launched)\b.*\b(?:now|waiting)\.{2,}$/i.test(t) ||
      /\bwaiting for it to finish\.{2,}$/i.test(t)
    );
  };

  while (idx < lines.length) {
    const current = lines[idx].trim();
    if (!current) {
      idx++;
      continue;
    }
    if (isInterimLine(current)) {
      interimUpdates.push(current);
      idx++;
    } else {
      break;
    }
  }

  const remaining = lines.slice(idx).join('\n').trim();
  if (!remaining) {
    return { interimUpdates: [], mainContent: normalized };
  }

  return {
    interimUpdates,
    mainContent: remaining,
  };
}

/**
 * Renders inline Markdown syntax:
 * - Inline code: `code`
 * - Links: `[label](url)` and `` [`Symbol`](file:///...) `` (including optional outer parens around file links)
 * - Bold + Italic: `***text***`
 * - Bold: `**text**` (supports nested inline code with `*` such as `` `packages/*` ``)
 * - Italic: `*text*`
 * - Strikethrough: `~~text~~`
 */
function renderInlineMarkdown(text: string, keyPrefix = 'inl'): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Combined token regex for inline markdown elements
  const tokenRegex =
    /(\(\[`[^`]+`\]\(file:\/\/[^)]+\)\)|\(\[[^\]]+\]\(file:\/\/[^)]+\)\)|\[`[^`]+`\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*\*(?:(?!\*\*\*).)+\*\*\*|\*\*(?:(?!\*\*).)+\*\*|~~(?:(?!~~).)+~~|\*(?!\s)[^*\n]+(?<!\s)\*)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let tokenIdx = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(normalizePlainSegment(text.slice(lastIndex, match.index)));
    }

    const rawToken = match[0];
    const key = `${keyPrefix}-${tokenIdx++}`;

    // Unwrap outer parentheses if it's a parenthesized file:// link like `([cli.ts](file:///...))`
    const isParenthesizedFileLink =
      rawToken.startsWith('([') && rawToken.endsWith('))') && rawToken.includes('](file://');
    const token = isParenthesizedFileLink ? rawToken.slice(1, -1) : rawToken;

    // 1. Link: [label](url) or [`code`](url)
    if (token.startsWith('[')) {
      const closeBracket = token.indexOf('](');
      if (closeBracket !== -1 && token.endsWith(')')) {
        const rawLabel = token.slice(1, closeBracket);
        const url = token.slice(closeBracket + 2, -1).trim();
        const isCodeLabel = rawLabel.startsWith('`') && rawLabel.endsWith('`') && rawLabel.length > 2;
        const cleanLabel = isCodeLabel ? rawLabel.slice(1, -1) : rawLabel;

        if (url.startsWith('file://')) {
          const fileInfo = parseFileUri(url);
          nodes.push(
            <button
              type="button"
              key={key}
              className={`md-file-chip ${isCodeLabel ? 'md-file-chip-symbol' : ''}`}
              title={`${fileInfo.fullPath} (Click to copy path)`}
              onClick={() => {
                navigator.clipboard?.writeText(fileInfo.fullPath).catch(() => {});
              }}
            >
              <span className="md-file-chip-icon">{isCodeLabel ? '⟨/⟩' : '↗'}</span>
              <span className={isCodeLabel ? 'md-file-chip-code' : 'md-file-chip-name'}>
                {cleanLabel}
              </span>
              {fileInfo.lineRange && !cleanLabel.includes('#') && (
                <span className="md-file-chip-lines">:{fileInfo.lineRange.replace(/^L/, '')}</span>
              )}
            </button>
          );
        } else {
          nodes.push(
            <a
              key={key}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="md-link"
            >
              {isCodeLabel ? <code className="md-inline-code">{cleanLabel}</code> : cleanLabel}
            </a>
          );
        }
        lastIndex = tokenRegex.lastIndex;
        continue;
      }
    }

    // 2. Inline code: `code`
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={key} className="md-inline-code">
          {token.slice(1, -1)}
        </code>
      );
      lastIndex = tokenRegex.lastIndex;
      continue;
    }

    // 3. Bold + Italic: ***text***
    if (token.startsWith('***') && token.endsWith('***')) {
      nodes.push(
        <strong key={key} className="md-bold">
          <em>{renderInlineMarkdown(token.slice(3, -3), key)}</em>
        </strong>
      );
      lastIndex = tokenRegex.lastIndex;
      continue;
    }

    // 4. Bold: **text**
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={key} className="md-bold">
          {renderInlineMarkdown(token.slice(2, -2), key)}
        </strong>
      );
      lastIndex = tokenRegex.lastIndex;
      continue;
    }

    // 5. Strikethrough: ~~text~~
    if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(
        <del key={key} className="md-strike">
          {renderInlineMarkdown(token.slice(2, -2), key)}
        </del>
      );
      lastIndex = tokenRegex.lastIndex;
      continue;
    }

    // 6. Italic: *text*
    if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em key={key} className="md-italic">
          {renderInlineMarkdown(token.slice(1, -1), key)}
        </em>
      );
      lastIndex = tokenRegex.lastIndex;
      continue;
    }

    nodes.push(normalizePlainSegment(rawToken));
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(normalizePlainSegment(text.slice(lastIndex)));
  }

  return nodes;
}

/**
 * Code block component with language badge and Copy button.
 */
function CodeBlockView({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{language || 'text'}</span>
        <button type="button" className="md-copy-btn" onClick={handleCopy}>
          {copied ? '✓ Copied' : 'Copy Code'}
        </button>
      </div>
      <pre className="md-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface ListItemNode {
  indent: number;
  ordered: boolean;
  marker: string;
  checked?: boolean;
  content: string;
  subItems: ListItemNode[];
}

function parseListBlock(lines: string[]): ListItemNode[] {
  const root: ListItemNode[] = [];
  const stack: ListItemNode[] = [];

  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      continue;
    }
    const match = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(rawLine);
    if (!match) {
      // Continuation line of the previous list item
      if (stack.length > 0) {
        stack[stack.length - 1].content += '\n' + rawLine.trim();
      }
      continue;
    }

    const indent = match[1].replace(/\t/g, '  ').length;
    const ordered = Boolean(match[3]);
    const marker = match[3] || match[2] || '-';
    let textContent = match[4];
    let checked: boolean | undefined;

    const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(textContent);
    if (taskMatch) {
      checked = taskMatch[1].toLowerCase() === 'x';
      textContent = taskMatch[2];
    }

    const node: ListItemNode = {
      indent,
      ordered,
      marker,
      checked,
      content: textContent,
      subItems: [],
    };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].subItems.push(node);
    }
    stack.push(node);
  }

  return root;
}

function renderListItemContent(content: string, keyPrefix: string): React.ReactNode {
  const lines = content.split('\n');
  return lines.map((line, idx) => (
    <React.Fragment key={`${keyPrefix}-ln-${idx}`}>
      {idx > 0 && <br />}
      {renderInlineMarkdown(line, `${keyPrefix}-ln-${idx}`)}
    </React.Fragment>
  ));
}

function renderListNodes(
  nodes: ListItemNode[],
  keyPrefix: string,
  depth = 0
): React.ReactNode {
  if (nodes.length === 0) return null;
  const isOrdered = nodes[0].ordered;
  const Tag = isOrdered ? 'ol' : 'ul';

  return (
    <Tag
      className={`md-list ${isOrdered ? 'md-list-ol' : 'md-list-ul'} ${
        depth === 0 ? 'md-list-root' : 'md-list-nested'
      }`}
    >
      {nodes.map((item, idx) => {
        const itemKey = `${keyPrefix}-${idx}`;
        const numericValue =
          item.ordered && /^\d+$/.test(item.marker) ? parseInt(item.marker, 10) : undefined;
        const isSectionItem = depth === 0 && isOrdered && item.subItems.length > 0;

        return (
          <li
            key={itemKey}
            value={numericValue}
            className={`md-list-item ${isSectionItem ? 'md-list-item-section' : ''}`}
          >
            {item.checked !== undefined ? (
              <span className="md-task-item">
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  className="md-task-checkbox"
                />
                <span className={item.checked ? 'md-task-done' : ''}>
                  {renderListItemContent(item.content, itemKey)}
                </span>
              </span>
            ) : (
              <div className="md-list-item-content">
                {renderListItemContent(item.content, itemKey)}
              </div>
            )}
            {item.subItems.length > 0 &&
              renderListNodes(item.subItems, `${itemKey}-sub`, depth + 1)}
          </li>
        );
      })}
    </Tag>
  );
}

/**
 * Rich GitHub-Flavored Markdown renderer for Agent responses.
 */
export function MarkdownRenderer({
  content,
  stripInterimUpdates = true,
}: {
  content: string;
  stripInterimUpdates?: boolean;
}) {
  const [showInterim, setShowInterim] = useState(false);

  const { interimUpdates, mainContent } = useMemo(
    () =>
      stripInterimUpdates
        ? splitInterimStatusUpdates(content)
        : { interimUpdates: [], mainContent: content },
    [content, stripInterimUpdates]
  );

  const blocks = useMemo(() => {
    const normalized = mainContent.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const elements: React.ReactNode[] = [];

    let i = 0;
    let blockKey = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 1. Blank line
      if (!line.trim()) {
        i++;
        continue;
      }

      // 2. Fenced Code Block (``` or ````)
      const fenceMatch = /^(`{3,4})([\w-]*)\s*$/.exec(line.trim());
      if (fenceMatch) {
        const fence = fenceMatch[1];
        const lang = fenceMatch[2] || 'text';
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // skip closing fence
        elements.push(
          <CodeBlockView
            key={`code-${blockKey++}`}
            language={lang}
            code={codeLines.join('\n')}
          />
        );
        continue;
      }

      // 3. Horizontal Rule (---, ***, ___)
      if (/^(?:---|\*\*\*|___)\s*$/.test(line.trim())) {
        elements.push(<hr key={`hr-${blockKey++}`} className="md-hr" />);
        i++;
        continue;
      }

      // 4. Headings (# to ######)
      const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const text = headingMatch[2].trim();
        const k = `h-${blockKey++}`;
        const children = renderInlineMarkdown(text, k);
        if (level === 1) elements.push(<h1 key={k} className="md-h1">{children}</h1>);
        else if (level === 2) elements.push(<h2 key={k} className="md-h2">{children}</h2>);
        else if (level === 3) elements.push(<h3 key={k} className="md-h3">{children}</h3>);
        else elements.push(<h4 key={k} className="md-h4">{children}</h4>);
        i++;
        continue;
      }

      // 5. Blockquotes & GitHub Alerts (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION])
      if (line.trim().startsWith('>')) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const firstLine = quoteLines[0]?.trim() || '';
        const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(firstLine);
        const k = `bq-${blockKey++}`;

        if (alertMatch) {
          const alertType = alertMatch[1].toUpperCase();
          const restFirstLine = alertMatch[2];
          const bodyLines = [
            ...(restFirstLine ? [restFirstLine] : []),
            ...quoteLines.slice(1),
          ];
          elements.push(
            <div key={k} className={`md-alert md-alert-${alertType.toLowerCase()}`}>
              <div className="md-alert-title">{alertType}</div>
              <div className="md-alert-body">
                {renderInlineMarkdown(bodyLines.join(' '), `${k}-body`)}
              </div>
            </div>
          );
        } else {
          elements.push(
            <blockquote key={k} className="md-blockquote">
              {quoteLines.map((ql, idx) => (
                <p key={`${k}-${idx}`} className="md-p">
                  {renderInlineMarkdown(ql, `${k}-${idx}`)}
                </p>
              ))}
            </blockquote>
          );
        }
        continue;
      }

      // 6. Markdown Table (| Col1 | Col2 | followed by | --- | --- |)
      if (
        line.includes('|') &&
        i + 1 < lines.length &&
        /^\s*\|?\s*[-:]+[-|\s:]*$/.test(lines[i + 1])
      ) {
        const parseCells = (rowStr: string) =>
          rowStr
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());

        const headers = parseCells(lines[i]);
        i += 2; // skip header + separator line
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trim().includes('|')) {
          rows.push(parseCells(lines[i]));
          i++;
        }

        const k = `tbl-${blockKey++}`;
        elements.push(
          <div key={k} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {headers.map((h, hIdx) => (
                    <th key={`${k}-th-${hIdx}`}>
                      {renderInlineMarkdown(h, `${k}-th-${hIdx}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, rIdx) => (
                  <tr key={`${k}-tr-${rIdx}`}>
                    {headers.map((_, cIdx) => (
                      <td key={`${k}-td-${rIdx}-${cIdx}`}>
                        {renderInlineMarkdown(r[cIdx] || '', `${k}-td-${rIdx}-${cIdx}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }

      // 7. Unordered or Ordered Lists (coalesce across single blank lines between items)
      if (/^(\s*)(?:[-*+]|\d+\.)\s+/.test(line)) {
        const listLines: string[] = [];
        while (i < lines.length) {
          const cur = lines[i];
          if (cur.trim() === '') {
            // Look ahead to see if the list continues after this blank line
            let nextIdx = i + 1;
            while (nextIdx < lines.length && lines[nextIdx].trim() === '') {
              nextIdx++;
            }
            if (
              nextIdx < lines.length &&
              (/^(\s*)(?:[-*+]|\d+\.)\s+/.test(lines[nextIdx]) ||
                (/^\s{2,}\S/.test(lines[nextIdx]) && !/^`{3,4}/.test(lines[nextIdx].trim())))
            ) {
              i = nextIdx;
              continue;
            }
            break;
          }

          if (
            /^(\s*)(?:[-*+]|\d+\.)\s+/.test(cur) ||
            (/^\s{2,}\S/.test(cur) && !/^`{3,4}/.test(cur.trim()))
          ) {
            listLines.push(cur);
            i++;
          } else {
            break;
          }
        }
        const k = `lst-${blockKey++}`;
        const parsedList = parseListBlock(listLines);
        elements.push(
          <div key={k} className="md-list-block">
            {renderListNodes(parsedList, k)}
          </div>
        );
        continue;
      }

      // 8. Standard Paragraph
      const paraLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^(`{3,4}|#{1,6}\s|>\s?|(\s*)(?:[-*+]|\d+\.)\s+|(?:---|\*\*\*|___)\s*$)/.test(
          lines[i]
        )
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      const k = `p-${blockKey++}`;
      elements.push(
        <p key={k} className="md-p">
          {paraLines.map((pl, idx) => (
            <React.Fragment key={`${k}-l-${idx}`}>
              {idx > 0 && <br />}
              {renderInlineMarkdown(pl, `${k}-l-${idx}`)}
            </React.Fragment>
          ))}
        </p>
      );
    }

    return elements;
  }, [mainContent]);

  return (
    <div className="md-root">
      {interimUpdates.length > 0 && (
        <div className="md-interim-banner">
          <button
            type="button"
            className="md-interim-toggle"
            onClick={() => setShowInterim((prev) => !prev)}
          >
            <span>
              ⏱ {interimUpdates.length} intermediate progress update
              {interimUpdates.length > 1 ? 's' : ''} hidden
            </span>
            <span>{showInterim ? '▾ Hide' : '▸ Show'}</span>
          </button>
          {showInterim && (
            <div className="md-interim-list">
              {interimUpdates.map((u, idx) => (
                <div key={idx} className="md-interim-item">
                  {renderInlineMarkdown(u, `interim-${idx}`)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {blocks}
    </div>
  );
}

/**
 * Dedicated reader card for "Latest Final Agent Response" with formatting controls,
 * copy button, font size toggle, and clean typography.
 */
export function FinalResponseCard({
  content,
  model,
  durationSeconds,
  totalTokens,
  turnCount,
  status,
}: {
  content: string;
  model?: string;
  durationSeconds?: number;
  totalTokens?: number;
  turnCount?: number;
  status?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [copied, setCopied] = useState(false);

  const { mainContent } = useMemo(() => splitInterimStatusUpdates(content), [content]);

  const handleCopy = () => {
    navigator.clipboard?.writeText(mainContent || content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="final-response-card">
      <div className="final-response-header">
        <div
          className="final-response-title-group"
          onClick={() => setCollapsed((prev) => !prev)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setCollapsed((prev) => !prev);
          }}
        >
          <span className="final-response-chevron">{collapsed ? '▸' : '▾'}</span>
          <span className="final-response-icon">✦</span>
          <span className="final-response-title">Latest Final Agent Response</span>
          {status === 'completed' && (
            <span className="badge badge-completed">FINAL SUMMARY</span>
          )}
          {model && <code className="conv-agent-model">{model}</code>}
          {durationSeconds !== undefined && durationSeconds > 0 && (
            <span className="final-response-meta-pill">{durationSeconds.toFixed(1)}s</span>
          )}
          {totalTokens !== undefined && totalTokens > 0 && (
            <span className="final-response-meta-pill">
              {totalTokens.toLocaleString()} tokens
            </span>
          )}
          {turnCount !== undefined && turnCount > 0 && (
            <span className="final-response-meta-pill">
              {turnCount} turn{turnCount > 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="final-response-actions">
          <button
            type="button"
            className={`final-response-btn ${!rawMode ? 'active' : ''}`}
            onClick={() => setRawMode(false)}
          >
            Formatted
          </button>
          <button
            type="button"
            className={`final-response-btn ${rawMode ? 'active' : ''}`}
            onClick={() => setRawMode(true)}
          >
            Raw Markdown
          </button>
          {!rawMode && (
            <button
              type="button"
              className={`final-response-btn ${largeText ? 'active' : ''}`}
              onClick={() => setLargeText((prev) => !prev)}
              title="Toggle larger reading font size"
            >
              Aa
            </button>
          )}
          <button
            type="button"
            className="md-copy-btn"
            onClick={handleCopy}
            title="Copy final Markdown response"
          >
            {copied ? '✓ Copied' : 'Copy Response'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div
          className={`final-response-body ${
            largeText ? 'final-response-body-lg' : ''
          }`}
        >
          {rawMode ? (
            <pre className="final-response-raw">{content}</pre>
          ) : (
            <MarkdownRenderer content={content} stripInterimUpdates={true} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible Tool Execution Timeline Pill Group
 */
function ToolGroupCard({ tools }: { tools: ToolExecutionItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const activeCount = tools.filter((t) => t.state === 'ACTIVE' || t.state === 'RUNNING').length;
  const doneCount = tools.filter((t) => t.state === 'DONE').length;

  // Summarize unique tool counts (e.g., "read_file ×4, run_command ×2")
  const summaryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tools) {
      counts.set(t.toolName, (counts.get(t.toolName) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, cnt]) => (cnt > 1 ? `${name} ×${cnt}` : name))
      .join(', ');
  }, [tools]);

  return (
    <div className={`conv-tool-group ${activeCount > 0 ? 'conv-tool-active' : ''}`}>
      <button
        type="button"
        className="conv-tool-header"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="conv-tool-header-left">
          <span className={`conv-tool-dot ${activeCount > 0 ? 'pulsing' : 'done'}`} />
          <span className="conv-tool-title">
            {activeCount > 0
              ? `Running tool${activeCount > 1 ? 's' : ''} (${doneCount}/${tools.length} completed)`
              : `Executed ${tools.length} tool call${tools.length > 1 ? 's' : ''}`}
          </span>
          <code className="conv-tool-summary">{summaryCounts}</code>
        </div>
        <span className="conv-tool-chevron">{expanded ? '▾ Hide' : '▸ Details'}</span>
      </button>

      {expanded && (
        <div className="conv-tool-list">
          {tools.map((t) => (
            <div key={t.id} className="conv-tool-item">
              <div className="conv-tool-item-main">
                <span
                  className={`badge ${
                    t.state === 'DONE'
                      ? 'badge-completed'
                      : t.state === 'ACTIVE'
                      ? 'badge-running'
                      : 'badge-warning'
                  }`}
                >
                  {t.state}
                </span>
                <code className="conv-tool-name">{t.toolName}</code>
                {t.durationSeconds !== undefined && (
                  <span className="conv-tool-duration">{t.durationSeconds.toFixed(2)}s</span>
                )}
                <span className="conv-tool-time">
                  {new Date(t.timestamp).toLocaleTimeString()}
                </span>
              </div>
              {t.args && Object.keys(t.args).length > 0 && (
                <pre className="conv-tool-args">
                  {JSON.stringify(t.args, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Agent Response Card with Copy Markdown button and rich Markdown formatting.
 */
function AgentResponseCard({
  markdown,
  isStreaming,
  durationSeconds,
  completionSummary,
  timestamp,
  model,
}: {
  markdown: string;
  isStreaming: boolean;
  durationSeconds?: number;
  completionSummary?: string;
  timestamp: string;
  model?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyResponse = () => {
    navigator.clipboard?.writeText(markdown).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className={`conv-agent-card ${isStreaming ? 'conv-agent-streaming' : ''}`}>
      <div className="conv-agent-header">
        <div className="conv-agent-identity">
          <span className="conv-agent-avatar">✦</span>
          <strong>Antigravity Agent</strong>
          {model && <code className="conv-agent-model">{model}</code>}
          {isStreaming && (
            <span className="badge badge-running conv-streaming-badge">
              ● Streaming...
            </span>
          )}
        </div>
        <div className="conv-agent-actions">
          <span className="conv-timestamp">
            {new Date(timestamp).toLocaleTimeString()}
          </span>
          <button
            type="button"
            className="md-copy-btn"
            onClick={handleCopyResponse}
            title="Copy raw Markdown response"
          >
            {copied ? '✓ Copied' : 'Copy Response'}
          </button>
        </div>
      </div>

      <div className="conv-agent-body">
        <MarkdownRenderer content={markdown} />
        {isStreaming && <span className="conv-streaming-cursor" />}
      </div>

      {(completionSummary || durationSeconds !== undefined) && (
        <div className="conv-agent-footer">
          <span>
            {completionSummary ||
              `Completed in ${(durationSeconds || 0).toFixed(1)}s`}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Main Session Stream & Response Viewer with Pretty View / Raw Log toggle.
 */
export function AgentSessionStreamView({
  logs,
  sessionPrompt,
  lastResponse,
  sessionStatus,
  model,
}: {
  logs: AgentLogEntry[];
  sessionPrompt?: string;
  lastResponse?: string;
  sessionStatus?: string;
  model?: string;
}) {
  const [viewMode, setViewMode] = useState<'pretty' | 'raw'>('pretty');
  const [expandedHeight, setExpandedHeight] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const coalescedItems = useMemo(
    () =>
      coalesceSessionLogs(logs, {
        fallbackPrompt: sessionPrompt,
        lastResponse,
        sessionStatus,
      }),
    [logs, sessionPrompt, lastResponse, sessionStatus]
  );

  // Auto-scroll when new logs stream in while running
  useEffect(() => {
    if (
      (sessionStatus === 'running' || sessionStatus === 'starting') &&
      scrollContainerRef.current
    ) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [logs.length, sessionStatus]);

  return (
    <div className="conv-viewer-wrapper">
      <div className="conv-toolbar">
        <div className="conv-view-tabs">
          <button
            type="button"
            className={`conv-tab-btn ${viewMode === 'pretty' ? 'active' : ''}`}
            onClick={() => setViewMode('pretty')}
          >
            ✨ Pretty Conversation View
          </button>
          <button
            type="button"
            className={`conv-tab-btn ${viewMode === 'raw' ? 'active' : ''}`}
            onClick={() => setViewMode('raw')}
          >
            &gt;_ Raw Stream ({logs.length} events)
          </button>
        </div>

        <div className="conv-toolbar-actions">
          <button
            type="button"
            className="conv-expand-btn"
            onClick={() => setExpandedHeight((prev) => !prev)}
          >
            {expandedHeight ? '↕ Compact Height' : '↕ Expand View'}
          </button>
        </div>
      </div>

      {viewMode === 'pretty' ? (
        <div
          ref={scrollContainerRef}
          className={`conv-pretty-container ${expandedHeight ? 'expanded' : ''}`}
        >
          {coalescedItems.length === 0 ? (
            <div className="conv-empty-state">
              <div className="conv-empty-spinner" />
              <span>Waiting for agent stream-json events...</span>
            </div>
          ) : (
            coalescedItems.map((item) => {
              if (item.kind === 'user_prompt') {
                return (
                  <div key={item.id} className="conv-user-card">
                    <div className="conv-user-header">
                      <span className="conv-user-badge">USER PROMPT</span>
                      <span className="conv-timestamp">
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="conv-user-prompt-text">{item.prompt}</div>
                  </div>
                );
              }

              if (item.kind === 'system_init') {
                return (
                  <div key={item.id} className="conv-system-pill">
                    <span>⚙️ Session Ready</span>
                    {item.conversationId && (
                      <code>conv: {item.conversationId.slice(0, 8)}…</code>
                    )}
                    {item.permissionMode && (
                      <span>mode: <code>{item.permissionMode}</code></span>
                    )}
                    {item.toolCount !== undefined && (
                      <span>{item.toolCount} tools loaded</span>
                    )}
                  </div>
                );
              }

              if (item.kind === 'tool_group') {
                return <ToolGroupCard key={item.id} tools={item.tools} />;
              }

              if (item.kind === 'agent_response') {
                return (
                  <AgentResponseCard
                    key={item.id}
                    markdown={item.markdown}
                    isStreaming={item.isStreaming}
                    durationSeconds={item.durationSeconds}
                    completionSummary={item.completionSummary}
                    timestamp={item.timestamp}
                    model={model}
                  />
                );
              }

              if (item.kind === 'notice') {
                return (
                  <div
                    key={item.id}
                    className={`conv-notice conv-notice-${item.level}`}
                  >
                    <span className="conv-notice-icon">
                      {item.level === 'error'
                        ? '❌'
                        : item.level === 'warning'
                        ? '⚠️'
                        : 'ℹ️'}
                    </span>
                    <span className="conv-notice-text">{item.text}</span>
                  </div>
                );
              }

              return null;
            })
          )}
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          className={`terminal-box ${expandedHeight ? 'expanded' : ''}`}
        >
          {logs.length === 0 ? (
            <div className="log-system">Waiting for stream-json events...</div>
          ) : (
            logs.map((l) => (
              <div key={l.id} className={`log-line log-${l.stream}`}>
                <span style={{ color: '#64748b' }}>
                  [{new Date(l.timestamp).toLocaleTimeString()}] [{l.stream.toUpperCase()}]{' '}
                </span>
                {l.text}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
