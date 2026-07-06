import { useEffect, useState } from 'react';
import { getResolvedTheme, type ResolvedTheme } from './theme';
import { getVizPalette, type VizPalette } from './vizPalette';

/** Re-render when app theme changes so viz colors stay in sync. */
export function useVizTheme(): { theme: ResolvedTheme; palette: VizPalette; tick: number } {
  const [tick, setTick] = useState(0);
  const theme = getResolvedTheme();
  const palette = getVizPalette(theme);

  useEffect(() => {
    const onTheme = () => setTick(t => t + 1);
    window.addEventListener('zettel:theme-changed', onTheme);
    return () => window.removeEventListener('zettel:theme-changed', onTheme);
  }, []);

  void tick;
  return { theme, palette: getVizPalette(getResolvedTheme()), tick };
}
