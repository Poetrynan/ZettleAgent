/**
 * i18n — 简单的中英文翻译系统
 */
import { en } from './en';
import { zh } from './zh';

export type Lang = 'en' | 'zh';
export type TranslationKey = keyof typeof en;

const translations = { en, zh } as const;

let currentLang: Lang = 'zh'; // Default to Chinese

export function setLang(lang: Lang) {
  currentLang = lang;
  localStorage.setItem('zettelagent-lang', lang);
  document.documentElement.setAttribute('lang', lang);
}

export function getLang(): Lang {
  return currentLang;
}

export function t(key: TranslationKey): string {
  return translations[currentLang][key] || translations.en[key] || key;
}

/**
 * Parameterized translation: replaces {0}, {1}, ... with provided args.
 * Usage: tf('canvas.diagIssues', totalIssues, orphans, broken, missing)
 */
export function tf(key: TranslationKey, ...args: (string | number)[]): string {
  let str: string = translations[currentLang][key] || translations.en[key] || key;
  for (let i = 0; i < args.length; i++) {
    str = str.replace(new RegExp(`\\{${i}\\}`, 'g'), String(args[i]));
  }
  return str;
}

// Initialize from localStorage
export function initLang() {
  const saved = localStorage.getItem('zettelagent-lang') as Lang | null;
  if (saved && (saved === 'en' || saved === 'zh')) {
    currentLang = saved;
  }
  document.documentElement.setAttribute('lang', currentLang);
}
