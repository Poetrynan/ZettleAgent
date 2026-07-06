import packageJson from '../../package.json';

/** Runtime app version from Tauri (matches tauri.conf / Cargo.toml). */
export async function getAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return packageJson.version;
  }
}
