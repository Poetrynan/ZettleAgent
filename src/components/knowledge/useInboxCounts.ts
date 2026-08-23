import { useCallback, useEffect, useState } from 'react';
import { getKnowledgeInboxCounts } from '../../lib/tauri';
import type { KnowledgeInboxCounts } from '../../lib/tauri';

/**
 * 收件箱计数 / the pending counts behind the badge.
 *
 * 单独一个模块而不是放在 `KnowledgeCenter.tsx` 里：顶栏角标在启动时就要显示，如果它
 * 从知识中心那个文件里 import，整个知识中心的代码就会被拉进启动包，懒加载白做。
 *
 * 顶栏和知识中心用同一个 hook，因为两处必须是同一个数字——角标说有 3 条、页面里只有
 * 2 条，用户就再也不会相信角标。
 */
export function useInboxCounts(pollMs = 30_000) {
  const [counts, setCounts] = useState<KnowledgeInboxCounts | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCounts(await getKnowledgeInboxCounts());
    } catch {
      // 角标读不到就不显示角标。为此弹一个错误提示会比问题本身更烦人；真正的故障会在
      // 知识中心的页面里报出来，那里有重试。
      setCounts(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [refresh, pollMs]);

  return { counts, refresh };
}
