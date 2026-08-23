import { describe, it, expect } from 'vitest';
import { collapseUnchanged, diffLines } from '../diff';

/**
 * 这个模块存在的理由是"同一份改动在哪儿看都一样"，所以测的是**结论**而不是实现：
 * 未改动的行必须被认出来（否则整段替换看起来像整篇重写）、越界时必须自报降级、
 * 折叠必须留下省略了多少行的记号。
 */
describe('diffLines', () => {
  it('keeps untouched lines untouched instead of marking the whole block replaced', () => {
    const before = 'one\ntwo\nthree';
    const after = 'one\ntwo point five\nthree';
    const { lines, stats, exact } = diffLines(before, after);

    expect(exact).toBe(true);
    expect(stats).toEqual({ added: 1, removed: 1, unchanged: 2 });
    expect(lines.filter(l => l.type === 'unchanged').map(l => l.text)).toEqual(['one', 'three']);
  });

  it('numbers both sides so a reader can find the line in the file', () => {
    const { lines } = diffLines('a\nb', 'a\nB');
    const removed = lines.find(l => l.type === 'removed');
    const added = lines.find(l => l.type === 'added');

    expect(removed).toMatchObject({ text: 'b', oldLine: 2, newLine: null });
    expect(added).toMatchObject({ text: 'B', oldLine: null, newLine: 2 });
  });

  it('treats a new file as all additions, with nothing removed', () => {
    const { lines, stats } = diffLines('', 'first\nsecond');
    expect(stats).toEqual({ added: 2, removed: 0, unchanged: 0 });
    expect(lines.every(l => l.type === 'added')).toBe(true);
  });

  it('treats a deletion as all removals, with nothing added', () => {
    const { stats } = diffLines('gone\nalso gone', '');
    expect(stats).toEqual({ added: 0, removed: 2, unchanged: 0 });
  });

  it('says so when it gives up on lining lines up', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const { exact, stats } = diffLines(huge, `${huge}\nextra`);

    // 降级必须自报：悄悄画一个"整篇删掉又整篇加回来"的 diff 是在撒谎。
    expect(exact).toBe(false);
    expect(stats.unchanged).toBe(0);
  });

  it('reports no change when both sides are identical', () => {
    const { stats } = diffLines('same\ntext', 'same\ntext');
    expect(stats).toEqual({ added: 0, removed: 0, unchanged: 2 });
  });
});

describe('collapseUnchanged', () => {
  it('records how many lines it hid so the gap is not read as the end of the file', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 30', 'line thirty');
    const { lines } = diffLines(before, after);

    const chunks = collapseUnchanged(lines, 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].skippedBefore).toBeGreaterThan(0);
    // 改动那一行前后各留两行上下文：一行孤零零的 diff 没法判断改在哪。
    expect(chunks[0].lines.some(l => l.text === 'line 28')).toBe(true);
    expect(chunks[0].lines.some(l => l.text === 'line thirty')).toBe(true);
  });

  it('keeps everything when every line changed', () => {
    const { lines } = diffLines('a\nb', 'c\nd');
    const chunks = collapseUnchanged(lines, 3);
    expect(chunks.flatMap(c => c.lines)).toHaveLength(lines.length);
  });
});
