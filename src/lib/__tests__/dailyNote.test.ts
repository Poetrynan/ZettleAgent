import { describe, it, expect } from 'vitest';
import { countWords } from '../dailyNote';

describe('dailyNote countWords', () => {
  it('should return 0 for empty or null content', () => {
    expect(countWords('')).toBe(0);
  });

  it('should ignore frontmatter when counting words', () => {
    const content = `---
date: 2026-06-26
type: journal
tags: [daily]
---
Hello World`;
    expect(countWords(content)).toBe(2);
  });

  it('should count English words correctly', () => {
    const content = 'Hello world, this is a test.';
    expect(countWords(content)).toBe(6);
  });

  it('should count Chinese characters correctly', () => {
    const content = '你好，世界！这是一次测试。';
    expect(countWords(content)).toBe(10);
  });

  it('should count mixed Chinese and English correctly', () => {
    const content = 'Hello世界，this is test测试';
    // English words: 'Hello', 'this', 'is', 'test' (4 words)
    // CJK characters: '世', '界', '测', '试' (4 characters)
    // Total should be 8
    expect(countWords(content)).toBe(8);
  });
});
