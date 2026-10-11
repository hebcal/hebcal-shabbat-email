import {calendar, flags, Location} from '@hebcal/core';
import {describe, expect, it} from 'vitest';
import {CalOptionsConfig, makeCalOptions} from '../src/calOptions.js';

const sanFrancisco = new Location(
  37.77493,
  -122.41942,
  false,
  'America/Los_Angeles',
  'San Francisco',
  'US',
  5391959
);

function makeCfg(overrides: Partial<CalOptionsConfig> = {}): CalOptionsConfig {
  return {location: sanFrancisco, m: 50, td: null, b: 18, ue: false, ...overrides};
}

// Thursday 2026-10-22 through Wednesday 2026-10-28, the window the weekly
// email covers when sent on 2026-10-22. Contains Latest Kiddush Levana
// for Cheshvan 5787 on Sunday 2026-10-25.
const start = new Date(2026, 9, 22);
const end = new Date(2026, 9, 28);

function kiddushLevanaEvents(cfg: CalOptionsConfig) {
  const options = makeCalOptions(cfg, start, end);
  return calendar(options).filter(ev => ev.mask & flags.KIDDUSH_LEVANA);
}

describe('makeCalOptions', () => {
  it('enables Kiddush Levana when Havdalah minutes are set', () => {
    expect(makeCalOptions(makeCfg(), start, end).kiddushLevanaMaharil).toBe(true);
    const evts = kiddushLevanaEvents(makeCfg());
    expect(evts).toHaveLength(1);
    expect(evts[0].getDesc()).toBe('Latest Kiddush Levana');
    expect(evts[0].getDate().greg().toDateString()).toBe('Sun Oct 25 2026');
  });

  it('enables Kiddush Levana when Havdalah uses degrees', () => {
    const cfg = makeCfg({m: null as unknown as number, td: 8.5});
    const options = makeCalOptions(cfg, start, end);
    expect(options.havdalahDeg).toBe(8.5);
    expect(options.kiddushLevanaMaharil).toBe(true);
    expect(kiddushLevanaEvents(cfg)).toHaveLength(1);
  });

  it('suppresses Kiddush Levana when Havdalah is disabled', () => {
    const cfg = makeCfg({m: 0});
    expect(makeCalOptions(cfg, start, end).kiddushLevanaMaharil).toBeUndefined();
    expect(kiddushLevanaEvents(cfg)).toHaveLength(0);
  });
});
