import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { textBlocks } from '../../src/research/grounding.js';

// A real response whose text has accented characters. Citation offsets in grounded answers count UTF-8
// bytes, not characters (see captured/README.txt), so they have to be converted before they can be matched
// to lines of the text.
const captured = JSON.parse(readFileSync(new URL('./captured/gemini-nonascii.json', import.meta.url), 'utf8'));

describe('citation offsets on a real non-ASCII response', () => {
  const [block] = textBlocks(captured).blocks;

  it('the raw offsets really are bytes: they run past the end of the text in characters', () => {
    const raw = captured.steps.find((s: { type: string }) => s.type === 'model_output').content[0].annotations as Array<{ end_index: number }>;
    expect(Math.max(...raw.map((a) => a.end_index))).toBeGreaterThan(block.text.length);
  });

  it('after conversion every citation sits inside the text', () => {
    expect(block.annotations.length).toBeGreaterThan(0);
    for (const a of block.annotations) {
      expect(a.start).toBeGreaterThanOrEqual(0);
      expect(a.end).toBeLessThanOrEqual(block.text.length);
      expect(a.start).toBeLessThan(a.end);
    }
  });

  it('each citation covers the end of one of the lines, the way the ASCII responses do', () => {
    const ends: number[] = [];
    let offset = 0;
    for (const line of block.text.split('\n')) {
      ends.push(offset + line.length);
      offset += line.length + 1;
    }
    for (const a of block.annotations) {
      // Grounded spans stop one character short of the line's end (the final full stop).
      expect(ends.some((end) => a.end === end || a.end === end - 1), `citation ending at ${a.end} lands on no line end`).toBe(true);
    }
  });

  it('the text keeps its accents', () => {
    expect(block.text).toContain('Montréal');
  });
});
