import { createContext, useContext, useEffect } from 'react';

export const SettingsDrafts = createContext<(id: string, dirty: boolean) => void>(() => {});
export function useSettingsDraft(id: string, dirty: boolean) {
  const report = useContext(SettingsDrafts);
  useEffect(() => { report(id, dirty); return () => report(id, false); }, [id, dirty, report]);
}
