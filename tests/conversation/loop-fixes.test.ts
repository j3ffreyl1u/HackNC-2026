import { describe, expect, it } from 'vitest';
import { parseDateWindows } from '../../src/conversation/dates.js';
import { validateIntent } from '../../src/conversation/intent.js';

const REF = '2026-10-14T12:00:00Z';

describe('fixes found by scripted chat loops', () => {
  it('"the weekend of Nov 21" is the Friday to Sunday around that Saturday', () => {
    expect(parseDateWindows('free the weekend of nov 21', REF)).toEqual([{ start: '2026-11-20', end: '2026-11-22' }]);
  });
  it('"somewhere warm" is a liking, not a destination', () => {
    expect(validateIntent({ intent: 'constraints', items: [{ field: 'region', text: 'Somewhere warm' }] }))
      .toEqual({ intent: 'constraints', items: [{ field: 'preferences', value: ['warm weather'] }] });
    expect(validateIntent({ intent: 'constraints', items: [{ field: 'region', text: 'anywhere' }] })).toEqual({ intent: 'clarify' });
  });
});
