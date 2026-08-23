/**
 * 行级 diff / the one line-diff in this app.
 *
 * 之前有三份：审批卡片自己一套 LCS，笔记历史一套 10 行前瞻启发式，文件恢复弹窗里
 * 又抄了一份那个启发式。同一份改动在三个界面上能画出三种结果，而用户会以为看到的
 * 是同一件事。所以算法只留一份，谁要画 diff 都从这里拿。
 *
 * 用 LCS 而不是启发式：启发式在"整段被替换"这种最需要看清的情况下会把整块标成
 * 删+增，看不出哪几行其实没动。
 */

export type DiffLineType = 'added' | 'removed' | 'unchanged';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 改之前的行号，`null` = 这一行是新增的。 */
  oldLine: number | null;
  /** 改之后的行号，`null` = 这一行被删掉了。 */
  newLine: number | null;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

/**
 * 超过这个行数就不跑 O(n·m) 的 DP。
 *
 * 上限存在的理由是界面不能卡住，但**降级必须是看得出来的**：越界时返回
 * `truncated: true`，调用方据此告诉用户"这份改动太大，只给了整块替换的视图"，
 * 而不是悄悄画一个看起来精确的假 diff。
 */
const MAX_DP_LINES = 400;

export interface DiffResult {
  lines: DiffLine[];
  stats: DiffStats;
  /** 真的走了 LCS 吗。`false` = 太大，退化成"整块替换"。 */
  exact: boolean;
}

export function diffLines(before: string, after: string): DiffResult {
  const oldLines = before === '' ? [] : before.split('\n');
  const newLines = after === '' ? [] : after.split('\n');

  if (oldLines.length > MAX_DP_LINES || newLines.length > MAX_DP_LINES) {
    const lines: DiffLine[] = [
      ...oldLines.map((text, i) => ({
        type: 'removed' as const,
        text,
        oldLine: i + 1,
        newLine: null,
      })),
      ...newLines.map((text, i) => ({
        type: 'added' as const,
        text,
        oldLine: null,
        newLine: i + 1,
      })),
    ];
    return { lines, stats: countStats(lines), exact: false };
  }

  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      lines.unshift({ type: 'unchanged', text: oldLines[i - 1], oldLine: i, newLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      lines.unshift({ type: 'added', text: newLines[j - 1], oldLine: null, newLine: j });
      j--;
    } else {
      lines.unshift({ type: 'removed', text: oldLines[i - 1], oldLine: i, newLine: null });
      i--;
    }
  }

  return { lines, stats: countStats(lines), exact: true };
}

function countStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of lines) {
    if (line.type === 'added') added++;
    else if (line.type === 'removed') removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}

/**
 * 只留改动附近的几行 / collapse long runs of untouched lines.
 *
 * 折叠的地方要留一个记号，否则"第 3 行接第 300 行"会被读成文件真的只有这么长。
 */
export interface DiffChunk {
  lines: DiffLine[];
  /** 这一段前面省略了多少行未改动的内容。 */
  skippedBefore: number;
}

export function collapseUnchanged(lines: DiffLine[], context = 3): DiffChunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === 'unchanged') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
      keep[k] = true;
    }
  });

  const chunks: DiffChunk[] = [];
  let current: DiffLine[] = [];
  let skipped = 0;
  let pendingSkip = 0;

  lines.forEach((line, index) => {
    if (keep[index]) {
      if (current.length === 0) {
        pendingSkip = skipped;
        skipped = 0;
      }
      current.push(line);
    } else {
      skipped++;
      if (current.length > 0) {
        chunks.push({ lines: current, skippedBefore: pendingSkip });
        current = [];
      }
    }
  });
  if (current.length > 0) chunks.push({ lines: current, skippedBefore: pendingSkip });

  return chunks;
}
