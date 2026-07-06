import { saveNoteSnapshot, getNoteSnapshots, NoteSnapshot } from './tauri';

export interface FileSnapshot {
  id?: number;
  filePath: string;
  content: string;
  timestamp: number;
  /** Source: 'indexeddb' or 'sqlite' */
  source?: 'indexeddb' | 'sqlite';
}

const DB_NAME = 'zettelagent-snapshots';
const STORE_NAME = 'snapshots';
const DB_VERSION = 1;
const sessionEdits = new Set<string>();

export function initDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('filePath', 'filePath', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

/**
 * Saves a content snapshot of a file if it meets the criteria (time, size, or first session edit).
 * Saves to BOTH IndexedDB (fast local cache) and SQLite (persistent backend).
 * Keeps a maximum of 100 snapshots per file in each store.
 */
export async function saveSnapshot(filePath: string, content: string): Promise<boolean> {
  let saved = false;

  // 1. Save to IndexedDB (fast local cache)
  try {
    const db = await initDb();

    // First, retrieve existing snapshots to compare and prune
    const getTx = db.transaction(STORE_NAME, 'readonly');
    const getStore = getTx.objectStore(STORE_NAME);
    const index = getStore.index('filePath');

    const snapshots: FileSnapshot[] = await new Promise((resolve, reject) => {
      const req = index.getAll(IDBKeyRange.only(filePath));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    // Sort descending by timestamp
    snapshots.sort((a, b) => b.timestamp - a.timestamp);

    const lastSnapshot = snapshots[0];
    const now = Date.now();

    // If content hasn't changed, do not save
    if (lastSnapshot && lastSnapshot.content === content) {
      // Still try SQLite save (it also deduplicates)
    } else {
      const isFirstSessionEdit = !sessionEdits.has(filePath);
      const timePassed = lastSnapshot ? (now - lastSnapshot.timestamp) >= 5 * 60 * 1000 : true;
      const sizeChanged = lastSnapshot ? Math.abs(content.length - lastSnapshot.content.length) >= 200 : true;

      if (isFirstSessionEdit || timePassed || sizeChanged) {
        sessionEdits.add(filePath);

        const writeTx = db.transaction(STORE_NAME, 'readwrite');
        const writeStore = writeTx.objectStore(STORE_NAME);

        await new Promise<void>((resolve, reject) => {
          const req = writeStore.add({ filePath, content, timestamp: now });
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });

        // Prune snapshots beyond 100 for this file
        if (snapshots.length >= 100) {
          const pruneTx = db.transaction(STORE_NAME, 'readwrite');
          const pruneStore = pruneTx.objectStore(STORE_NAME);
          const toDelete = snapshots.slice(99); // Keep latest 99 + the new one = 100
          for (const snap of toDelete) {
            if (snap.id !== undefined) {
              pruneStore.delete(snap.id);
            }
          }
        }
        saved = true;
      }
    }
  } catch (err) {
    console.error('Failed to save snapshot to IndexedDB:', err);
  }

  // 2. Save to SQLite (persistent backend — survives WebView2 data clearing)
  try {
    await saveNoteSnapshot(filePath, content);
  } catch (err) {
    console.error('Failed to save snapshot to SQLite:', err);
  }

  return saved;
}

/**
 * Gets all snapshots for a given file, sorted from newest to oldest.
 * Merges IndexedDB and SQLite snapshots, deduplicating by content+timestamp.
 */
export async function getSnapshots(filePath: string): Promise<FileSnapshot[]> {
  // Try SQLite first (authoritative persistent store)
  let sqliteSnapshots: FileSnapshot[] = [];
  try {
    const dbSnaps = await getNoteSnapshots(filePath);
    sqliteSnapshots = dbSnaps.map(s => ({
      id: s.id,
      filePath: s.file_path,
      content: s.content,
      timestamp: s.created_at_ms,
      source: 'sqlite' as const,
    }));
  } catch (err) {
    console.error('Failed to get snapshots from SQLite:', err);
  }

  // Also get from IndexedDB (may have very recent snapshots not yet synced)
  let idbSnapshots: FileSnapshot[] = [];
  try {
    const db = await initDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('filePath');

    idbSnapshots = await new Promise((resolve, reject) => {
      const req = index.getAll(IDBKeyRange.only(filePath));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    idbSnapshots.forEach(s => { s.source = 'indexeddb'; });
  } catch (err) {
    console.error('Failed to get snapshots from IndexedDB:', err);
  }

  // Merge: prefer SQLite snapshots, add IndexedDB ones that don't have matching content
  const seen = new Set<string>();
  const merged: FileSnapshot[] = [];

  for (const snap of sqliteSnapshots) {
    const key = `${snap.content.length}:${snap.timestamp}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(snap);
    }
  }

  for (const snap of idbSnapshots) {
    const key = `${snap.content.length}:${snap.timestamp}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(snap);
    }
  }

  // Sort newest first
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged;
}

/**
 * Clears old snapshots globally (IndexedDB only — SQLite auto-prunes per file).
 */
export async function pruneOldSnapshots(maxAgeDays: number = 30): Promise<void> {
  try {
    const db = await initDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    await new Promise<void>((resolve, reject) => {
      const range = IDBKeyRange.upperBound(cutoff);
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  } catch (err) {
    console.error('Failed to prune old snapshots:', err);
  }
}
