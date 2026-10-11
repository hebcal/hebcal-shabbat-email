import {CalOptions, Location} from '@hebcal/core';

/** Subset of a subscriber config that the calendar options depend on. */
export type CalOptionsConfig = {
  location: Location;
  m: number;
  td: number | null;
  b: number;
  ue: boolean;
};

/**
 * Builds the `calendar()` options for one subscriber's
 * weekly email covering `start` through `end`.
 */
export function makeCalOptions(cfg: CalOptionsConfig, start: Date, end: Date): CalOptions {
  const location = cfg.location;
  const options: CalOptions = {
    start,
    end,
    location,
    candlelighting: true,
    candleLightingMins: cfg.b,
    il: location.getIsrael(),
    sedrot: true,
    shabbatMevarchim: true,
    useElevation: cfg.ue,
  };
  if (typeof cfg.m === 'number') {
    options.havdalahMins = cfg.m;
  } else if (typeof cfg.td === 'number') {
    options.havdalahDeg = cfg.td;
  }
  // candlelighting and Rosh Chodesh are always on for the weekly email,
  // so only suppress Kiddush Levana when Havdalah is explicitly disabled
  if (options.havdalahMins !== 0) {
    options.kiddushLevanaMaharil = true;
  }
  return options;
}
