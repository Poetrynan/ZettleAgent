import { writeMarkdownFile, createFolder, readMarkdownFile } from './tauri';
import { desktopDir, join } from '@tauri-apps/api/path';
import { loadDailyNotePath } from './storage';
import { exists, mkdir, readDir } from '@tauri-apps/plugin-fs';

const DAILY_FOLDER_NAME = 'ZettelAgent Daily';

/**
 * Get the daily notes folder path.
 * Uses custom path from Settings if configured, otherwise defaults to Desktop/ZettelAgent Daily.
 * Creates the folder if it doesn't exist.
 */
export async function getDailyFolderPath(): Promise<string> {
  // Check for user-configured custom path
  const customPath = await loadDailyNotePath();

  if (customPath && customPath.length > 0) {
    // Ensure the custom directory exists
    try {
      const dirExists = await exists(customPath);
      if (!dirExists) {
        await mkdir(customPath, { recursive: true });
      }
    } catch {
      // If creation fails, fall through to default
      console.warn('Failed to create custom daily note folder, using default');
    }
    // Verify it exists now
    try {
      const dirExists = await exists(customPath);
      if (dirExists) return customPath;
    } catch { /* fall through */ }
  }

  // Default: Desktop/ZettelAgent Daily
  const desktop = await desktopDir();
  const dailyPath = await join(desktop, DAILY_FOLDER_NAME);

  // Ensure the daily notes folder exists
  try {
    const dirExists = await exists(dailyPath);
    if (!dirExists) {
      await mkdir(dailyPath, { recursive: true });
    }
  } catch (err) {
    console.warn('Failed to create daily notes folder:', err);
    // Try alternative method
    try {
      await createFolder(desktop, DAILY_FOLDER_NAME);
    } catch {
      // Folder might already exist or creation failed — continue anyway
    }
  }

  return dailyPath;
}

/**
 * Get today's date string in YYYY-MM-DD format.
 */
function getTodayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Generate daily note template content.
 */
function getDailyNoteTemplateForDate(dateStr: string): string {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  const dateObj = new Date(year, month, day);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = days[dateObj.getDay()];

  return `---
date: ${dateStr}
type: journal
tags: [daily]
---

# ${dateStr} ${dayName}

## Notes


## Tasks


## Ideas

`;
}

/**
 * Open or create today's daily note.
 */
export async function openOrCreateDailyNote(): Promise<string> {
  return openOrCreateDailyNoteForDate(getTodayString());
}

/**
 * Open or create a daily note for a specific date (YYYY-MM-DD).
 */
export async function openOrCreateDailyNoteForDate(dateStr: string): Promise<string> {
  const dailyPath = await getDailyFolderPath();
  const fileName = `${dateStr}.md`;
  const fullPath = await join(dailyPath, fileName);

  const fileExists = await exists(fullPath);
  if (!fileExists) {
    const template = getDailyNoteTemplateForDate(dateStr);
    await writeMarkdownFile(fullPath, template);
  }

  notifyDailyNotesChanged();
  return fullPath;
}

/** Notify sidebar / calendar to refresh daily-note lists. */
export function notifyDailyNotesChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('zettel:daily-notes-changed'));
  }
}

export interface DailyNoteInfo {
  date: string;
  path: string;
  wordCount: number;
  content: string;
}

/**
 * Count CJK characters and Latin words.
 */
export function countWords(content: string): number {
  if (!content) return 0;
  
  // Clean frontmatter first if present
  let cleanContent = content;
  if (content.startsWith('---')) {
    const endFrontmatter = content.indexOf('---', 3);
    if (endFrontmatter !== -1) {
      cleanContent = content.substring(endFrontmatter + 3);
    }
  }
  
  // Count CJK characters
  const cjkCount = (cleanContent.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  
  // Count English/Latin words by matching alphanumeric sequences, ignoring punctuation
  const englishContent = cleanContent.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const englishWords = englishContent.match(/[a-zA-Z0-9_'-]+/g) || [];
  const englishWordCount = englishWords.length;
  
  return cjkCount + englishWordCount;
}

/**
 * List all daily notes in the Daily Note folder.
 */
export async function listDailyNotes(): Promise<Record<string, DailyNoteInfo>> {
  const dailyPath = await getDailyFolderPath();
  const notes: Record<string, DailyNoteInfo> = {};
  
  try {
    const entries = await readDir(dailyPath);
    const readPromises = entries.map(async (entry) => {
      if (entry.isFile && entry.name.endsWith('.md')) {
        const nameWithoutExt = entry.name.slice(0, -3);
        if (/^\d{4}-\d{2}-\d{2}$/.test(nameWithoutExt)) {
          const fullPath = await join(dailyPath, entry.name);
          try {
            const content = await readMarkdownFile(fullPath);
            const wordCount = countWords(content);
            notes[nameWithoutExt] = {
              date: nameWithoutExt,
              path: fullPath,
              wordCount,
              content,
            };
          } catch (e) {
            console.error(`Failed to read daily note ${entry.name}:`, e);
          }
        }
      }
    });
    
    await Promise.all(readPromises);
  } catch (e) {
    console.error('Failed to list daily notes:', e);
  }
  
  return notes;
}
