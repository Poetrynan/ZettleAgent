import type { TimelineEntry } from './useChatSessions';

export type AgentAnswerSource =
  | 'loop'
  | 'mandatory'
  | 'stub_retry'
  | 'timeline';

const LEAK_PATTERNS = [
  /^Do not repeat the same tool calls\.?\s*/i,
  /^Do not repeat similar searches\.?\s*/i,
  /^Please do not repeat this call\.?\s*/i,
  /^请勿再次调用 todo_write\.?\s*/,
  /^请勿重复调用\.?\s*/,
  /^请勿重复相似搜索\.?\s*/,
  /^Plan note:.*$/gm,
  /^Plan enforcement:.*$/gm,
  /^⛔.*$/gm,
  /^Observation: Tool execution completed.*$/gm,
  /^⚠️ Stagnation Detected:.*$/gm,
  /^⚠️ 检测到停滞：.*$/gm,
  /^## Recovery:.*$/gm,
  /^## 恢复：.*$/gm,
  /^⚠️ Recovery Mode.*$/gm,
];

const RECOVERY_MARKERS = [
  '## Recovery:',
  '## 恢复：',
  'Recovery: Ask for Guidance',
  'Recovery: Broaden Your Search',
  'Recovery: Switch Your Approach',
  'Try a Different Approach',
  'Engage the user for guidance',
  '⚠️ Stagnation Detected',
  '⚠️ 检测到停滞',
];

/** Strip recovery / stagnation system prompts the model sometimes echoes into thinking. */
export function stripRecoveryEcho(text: string): string {
  let out = text.trim();
  for (const marker of RECOVERY_MARKERS) {
    const idx = out.indexOf(marker);
    if (idx >= 0) {
      out = out.slice(0, idx).trim();
    }
  }
  return out.replace(/\s*Observation: Tool execution completed[\s\S]*$/i, '').trim();
}

/** Orchestration system messages the model sometimes echoes into thinking / answers. */
export function isOrchestrationNoise(text: string): boolean {
  const c = text.trim();
  if (!c) return false;
  return (
    c.includes('Plan enforcement')
    || c.includes('Plan note:')
    || c.includes('计划约束')
    || c.includes('计划提示')
    || (c.includes('⛔') && c.includes('todo_write'))
    || c.includes('Do NOT call todo_write')
    || c.includes('请勿再次调用 todo_write')
    || c.startsWith('Observation: Tool execution completed')
    || c.startsWith('观察：工具执行已完成')
    || c.includes('Stagnation Detected')
    || c.includes('检测到停滞')
    || c.includes('Duplicate tool execution blocked')
    || c.includes('## Recovery:')
    || c.includes('## 恢复：')
    || c.includes('Recovery: Ask for Guidance')
    || c.includes('Engage the user for guidance')
    || c.includes('Internal guidance: do NOT quote')
    || c.includes('内部指引：勿向用户复述')
  );
}

/** Strip orchestration noise lines/blocks from a thinking blob for display. */
export function cleanThoughtForDisplay(text: string): string {
  if (!text.trim()) return '';
  const withoutRecovery = stripRecoveryEcho(text);
  const parts = withoutRecovery
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !isOrchestrationNoise(p));
  return parts.join('\n\n').trim();
}

const META_STUB_PATTERNS = [
  /^I have completed/i,
  /analysis is complete and ready for your review/i,
  /^我已完成/,
  /^我已经完成/,
  /分析已完成/,
  /报告已就绪/,
  /扫描已完成/,
  /ready for your review/i,
];

export interface AgentAnswerPick {
  answer: string;
  source: AgentAnswerSource;
}

/** Remove system-instruction text the model sometimes echoes into the answer. */
export function stripAgentAnswerLeaks(text: string): string {
  let out = text.trim();
  for (const re of LEAK_PATTERNS) {
    out = out.replace(re, '');
  }
  return out.trim();
}

function isMetaStubAnswer(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return META_STUB_PATTERNS.some((re) => re.test(t));
}

/** Mid-loop planning narration — not a final report; must not replace the Answer block. */
function looksLikePlanningNarration(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const patterns = [
    /let'?s try a different approach/i,
    /I('ll| will) start by/i,
    /creating a todo plan/i,
    /multi-step diagnostic task/i,
    /^This is a .+ task that requires/i,
    /then execute the necessary tools/i,
    /we('ll| will) use `?\w+`? to search/i,
  ];
  return patterns.some((re) => re.test(t));
}

/**
 * Remove final report text incorrectly duplicated into the last timeline thought
 * (legacy streaming bug or partial overlap with orchestration prefix).
 */
export function stripReportFromTimeline(
  timeline: TimelineEntry[] | undefined,
  cleanResult: string,
): TimelineEntry[] | undefined {
  if (!timeline?.length || !cleanResult.trim()) return timeline;

  const trimmedClean = cleanResult.trim();
  const lastTextIdx = [...timeline].reverse().findIndex((e) => e.type === 'thought');
  if (lastTextIdx < 0) return timeline;

  const idx = timeline.length - 1 - lastTextIdx;
  const lastTextEntry = timeline[idx];
  const textVal = lastTextEntry.content || '';
  const searchStr = trimmedClean.substring(0, Math.min(50, trimmedClean.length));
  const overlapIdx = textVal.indexOf(searchStr);

  if (overlapIdx > 0) {
    const remaining = textVal.substring(0, overlapIdx).trim();
    if (remaining) {
      return [
        ...timeline.slice(0, idx),
        { ...lastTextEntry, content: remaining },
        ...timeline.slice(idx + 1),
      ];
    }
    return [...timeline.slice(0, idx), ...timeline.slice(idx + 1)];
  }

  if (overlapIdx === 0) {
    return [...timeline.slice(0, idx), ...timeline.slice(idx + 1)];
  }

  const trimmedTextVal = textVal.trim();
  if (trimmedTextVal.endsWith(trimmedClean)) {
    const remaining = trimmedTextVal.slice(0, trimmedTextVal.length - trimmedClean.length).trim();
    if (remaining) {
      return [
        ...timeline.slice(0, idx),
        { ...lastTextEntry, content: remaining },
        ...timeline.slice(idx + 1),
      ];
    }
    return [...timeline.slice(0, idx), ...timeline.slice(idx + 1)];
  }

  return timeline;
}

/** Stage status labels that must never prefix model answer text in a thought row. */
const STAGE_STATUS_PREFIXES = [
  'Planning & executing…',
  'Planning & executing...',
  'Routing request to the right agent…',
  'Routing request to the right agent...',
  'Loading tools & building agent…',
  'Loading tools & building agent...',
  'Executing…',
  'Executing...',
  '正在路由到合适的 Agent…',
  '正在将请求路由到合适的 Agent…',
  '正在加载工具与构建 Agent…',
  '正在规划与执行…',
  '正在执行…',
  'Starting…',
  '正在启动…',
];

/** Regex fallback when ellipsis variant or spacing differs from the canonical label. */
const STAGE_PREFIX_RE =
  /^(Planning & executing[\.…]+|Routing request to the right agent[\.…]+|Loading tools & building agent[\.…]+|Executing[\.…]+|Starting[\.…]+|正在(?:将请求)?路由到合适的 Agent[\.…]+|正在加载工具与构建 Agent[\.…]+|正在规划与执行[\.…]+|正在执行[\.…]+|正在启动[\.…]+)\s*/u;

export function isExactStageLabel(content: string): boolean {
  const trimmed = content.trim();
  return STAGE_STATUS_PREFIXES.some((p) => trimmed === p.trim());
}

/** Whether streamed tokens should append to the answer bubble (vs agent trace). */
export function isAgentAnswerStream(
  msg: { isAgentStep?: boolean; toolCalls?: unknown[] },
  answerStreamAfterClear: boolean,
): boolean {
  if (answerStreamAfterClear) return true;
  // Non-agent turns (RAG): stream to bubble when no tools yet.
  if (!msg.isAgentStep) {
    return !(msg.toolCalls && (msg.toolCalls as unknown[]).length > 0);
  }
  // Agent mode: only the explicit synthesis pass writes to the answer bubble.
  return false;
}

/** Seed timeline so Agent trace renders from the first frame (no layout flip). */
export function initialAgentTimeline(isZh: boolean): TimelineEntry[] {
  return [{
    type: 'thought',
    content: isZh ? '正在启动…' : 'Starting…',
    index: 0,
    isStage: true,
  }];
}

/** Remove a leading orchestration stage label from free text. */
export function stripStagePrefixFromText(text: string): string {
  let content = text;
  for (const prefix of STAGE_STATUS_PREFIXES) {
    if (content.startsWith(prefix)) {
      return content.slice(prefix.length).trimStart();
    }
  }
  return content.replace(STAGE_PREFIX_RE, '').trimStart();
}

/** Return only the short stage status label when text includes leaked answer content. */
export function extractStageLabelOnly(content: string): string {
  const trimmed = content.trim();
  if (isExactStageLabel(trimmed)) return trimmed;
  const match = trimmed.match(STAGE_PREFIX_RE);
  return match ? match[0].trim() : trimmed;
}

/**
 * Split stage orchestration text accidentally merged into a model thought row
 * (e.g. "Planning & executing…我可以帮你…").
 */
export function stripStageLeakFromTimeline(
  timeline: TimelineEntry[] | undefined,
): TimelineEntry[] | undefined {
  if (!timeline?.length) return timeline;

  const out: TimelineEntry[] = [];
  for (const entry of timeline) {
    if (entry.type !== 'thought') {
      out.push(entry);
      continue;
    }
    const raw = entry.content || '';
    if (entry.isStage) {
      // Stage rows must only carry the short status label — never model answer text.
      if (isExactStageLabel(raw)) {
        out.push(entry);
      } else {
        const remainder = stripStagePrefixFromText(raw);
        if (remainder && !isExactStageLabel(remainder)) {
          out.push({ ...entry, isStage: false, content: remainder });
        }
      }
      continue;
    }
    const content = stripStagePrefixFromText(raw);
    if (!content.trim()) continue;
    out.push({ ...entry, content });
  }
  return out.length ? out : undefined;
}

/**
 * Finalize trace after a turn: strip stage leaks and drop duplicate model text
 * for direct replies (no tool calls) when the answer bubble already has content.
 */
export function finalizeAgentTimeline(
  timeline: TimelineEntry[] | undefined,
  answerContent: string,
  hasTools: boolean,
): TimelineEntry[] | undefined {
  let t = stripStageLeakFromTimeline(timeline);
  if (!t?.length) return t;

  const answer = answerContent?.trim() ?? '';
  if (!hasTools && answer.length > 0) {
    // Chitchat / capability Q&A: answer lives in the bubble — hide the trace entirely.
    t = t.filter((e) => e.type !== 'thought');
  } else if (answer.length > 0) {
    // Drop thought rows whose body is duplicated in the final answer.
    t = t.filter((e) => {
      if (e.type !== 'thought') return true;
      if (e.isStage) return isExactStageLabel(e.content || '');
      const body = stripStagePrefixFromText(e.content || '').trim();
      if (!body) return false;
      if (body.length < 40) return true;
      if (answer.includes(body) || body.includes(answer)) return false;
      return true;
    });
  }

  return t.length ? t : undefined;
}

/** Collect substantive reasoning blocks from the agent timeline (not stage status lines). */
export function collectTimelineThinking(timeline?: TimelineEntry[]): string {
  if (!timeline?.length) return '';
  return timeline
    .filter(
      (e) =>
        (e.type === 'thought') &&
        !e.isStage &&
        (e.content?.trim().length ?? 0) > 80 &&
        !isOrchestrationNoise(e.content || ''),
    )
    .map((e) => cleanThoughtForDisplay(e.content!.trim()))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Prefer the richest user-facing report: timeline thinking often holds the full
 * analysis while the final LLM `content` is only a short meta stub.
 */
export function pickAgentFinalAnswer(
  cleanResult: string,
  timeline?: TimelineEntry[],
  backendSource?: string,
): AgentAnswerPick {
  const answer = stripAgentAnswerLeaks(cleanResult);
  const thinking = collectTimelineThinking(timeline);

  const backend = normalizeBackendSource(backendSource);

  if (!thinking) {
    return { answer, source: backend ?? 'loop' };
  }

  const metaStub = isMetaStubAnswer(answer);
  const looksLikeLeak = isOrchestrationNoise(answer) || LEAK_PATTERNS.some((re) => re.test(answer));
  const synthesisFailed =
    backend === 'mandatory' || backend === 'stub_retry'
      ? answer.length < 400 || metaStub
      : false;

  // Timeline promotion: only when backend synthesis failed, and thinking looks like a report.
  if (
    synthesisFailed
    && thinking.length > 500
    && !looksLikePlanningNarration(thinking)
  ) {
    const reportMarkers = [
      '关键发现',
      '行动计划',
      'MOC',
      '孤立',
      'Key findings',
      'Action plan',
      'Executive summary',
      '执行摘要',
    ];
    const thinkingHasReport = reportMarkers.some((m) => thinking.includes(m));
    if (thinkingHasReport || thinking.length > answer.length * 1.4) {
      return { answer: thinking, source: 'timeline' };
    }
  }

  return { answer: answer || thinking, source: backend ?? (answer ? 'loop' : 'timeline') };
}

function normalizeBackendSource(raw?: string): AgentAnswerSource | undefined {
  if (raw === 'mandatory' || raw === 'stub_retry' || raw === 'loop') return raw;
  return undefined;
}

export function formatAnswerSourceLabel(source: AgentAnswerSource, isZh: boolean): string {
  const labels: Record<AgentAnswerSource, [string, string]> = {
    loop: ['来源：Loop', 'Source: loop'],
    mandatory: ['来源：Synthesis', 'Source: synthesis'],
    stub_retry: ['来源：Synthesis（补全）', 'Source: synthesis (retry)'],
    timeline: ['来源：Timeline 提升', 'Source: timeline promotion'],
  };
  const [zh, en] = labels[source];
  return isZh ? zh : en;
}
