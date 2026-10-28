import {describe, expect, it} from 'vitest';
import {
  DEFAULT_OPTIONS,
  HardRow,
  SoftRow,
  parseReasons,
  selectCandidates,
} from '../src/deactivate.js';

function soft(email_address: string, overrides: Partial<SoftRow> = {}): SoftRow {
  return {
    email_address,
    std_reason: 'over_quota',
    weeks: 40,
    span_days: 300,
    days_since_last: 3,
    ...overrides,
  };
}

describe('selectCandidates: hard bounces', () => {
  it('deactivates above the count threshold, not at it', () => {
    const rows: HardRow[] = [
      {email_address: 'a@x.test', std_reason: 'user_unknown', count: 8},
      {email_address: 'b@x.test', std_reason: 'user_unknown', count: 7},
    ];
    const got = selectCandidates(rows, [], DEFAULT_OPTIONS);
    expect([...got]).toEqual([['a@x.test', 'user_unknown']]);
  });

  it('deactivates on a single amzn_abuse', () => {
    const rows: HardRow[] = [{email_address: 'a@x.test', std_reason: 'amzn_abuse', count: 1}];
    expect(selectCandidates(rows, [], DEFAULT_OPTIONS).get('a@x.test')).toBe('amzn_abuse');
  });

  it('coerces string counts from the driver', () => {
    const rows = [
      {email_address: 'a@x.test', std_reason: 'spam', count: '9'},
    ] as unknown as HardRow[];
    expect(selectCandidates(rows, [], DEFAULT_OPTIONS).size).toBe(1);
  });
});

describe('selectCandidates: soft bounces', () => {
  it('deactivates a mailbox that has been full for months', () => {
    const got = selectCandidates([], [soft('a@x.test')], DEFAULT_OPTIONS);
    expect(got.get('a@x.test')).toBe('over_quota');
  });

  it('accepts exactly the thresholds', () => {
    const row = soft('a@x.test', {weeks: 8, span_days: 60, days_since_last: 30});
    expect(selectCandidates([], [row], DEFAULT_OPTIONS).size).toBe(1);
  });

  it('ignores a burst: many rows but few distinct weeks', () => {
    const row = soft('a@x.test', {std_reason: 'Transient', weeks: 3, span_days: 2});
    expect(selectCandidates([], [row], DEFAULT_OPTIONS).size).toBe(0);
  });

  it('ignores weekly bounces that have not lasted long enough', () => {
    const row = soft('a@x.test', {weeks: 8, span_days: 49});
    expect(selectCandidates([], [row], DEFAULT_OPTIONS).size).toBe(0);
  });

  it('ignores an address that stopped bouncing', () => {
    const row = soft('a@x.test', {days_since_last: 31});
    expect(selectCandidates([], [row], DEFAULT_OPTIONS).size).toBe(0);
  });
});

describe('selectCandidates: attribution', () => {
  it('counts each address once, preferring the hard reason', () => {
    const hard: HardRow[] = [{email_address: 'a@x.test', std_reason: 'spam', count: 20}];
    const softRows = [soft('a@x.test'), soft('a@x.test', {std_reason: 'Transient'})];
    const got = selectCandidates(hard, softRows, DEFAULT_OPTIONS);
    expect([...got]).toEqual([['a@x.test', 'spam']]);
  });

  it('keeps the first soft reason when both qualify', () => {
    const softRows = [soft('a@x.test', {std_reason: 'Transient'}), soft('a@x.test')];
    expect(selectCandidates([], softRows, DEFAULT_OPTIONS).get('a@x.test')).toBe('Transient');
  });
});

describe('parseReasons', () => {
  it('falls back to the default', () => {
    expect(parseReasons(undefined, 'a,b')).toEqual(['a', 'b']);
  });
  it('treats none and empty as disabled', () => {
    expect(parseReasons('none', 'a,b')).toEqual([]);
    expect(parseReasons('', 'a,b')).toEqual([]);
  });
  it('trims and drops empties', () => {
    expect(parseReasons(' a, ,b ', 'x')).toEqual(['a', 'b']);
  });
});
