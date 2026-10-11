import {calendar, Location} from '@hebcal/core';
import dayjs from 'dayjs';
import {describe, expect, it} from 'vitest';
import {CalOptionsConfig, makeCalOptions} from '../src/calOptions.js';
import {SpecialNoteConfig} from '../src/specialNote.js';
import {
  compareConfigs,
  formatSentLogLine,
  makeSubjectAndBody,
  getStartAndEnd,
  parseSentLog,
} from '../src/weeklyBody.js';

const sanFrancisco = new Location(
  37.77493,
  -122.41942,
  false,
  'America/Los_Angeles',
  'San Francisco',
  'US',
  5391959
);
const jerusalem = new Location(31.76, 35.23, true, 'Asia/Jerusalem', 'Jerusalem', 'IL', 281184);

type Cfg = CalOptionsConfig & SpecialNoteConfig;

function makeCfg(overrides: Partial<Cfg> = {}): Cfg {
  return {location: sanFrancisco, m: 50, td: null, b: 18, ue: false, zip: '94103', ...overrides};
}

/** Renders the weekly email exactly as shabbat_weekly would on `ymd`. */
function render(ymd: string, cfg: Cfg = makeCfg()) {
  const today = dayjs(ymd);
  const [start, end] = getStartAndEnd(today.toDate());
  const options = makeCalOptions(cfg, start.toDate(), end.toDate());
  return makeSubjectAndBody(calendar(options), options, cfg, today);
}

describe('getStartAndEnd', () => {
  it('spans from midnight today through six days later', () => {
    const [start, end] = getStartAndEnd(new Date(2026, 9, 22, 15, 30));
    expect(start.format('YYYY-MM-DD HH:mm')).toBe('2026-10-22 00:00');
    expect(end.format('YYYY-MM-DD')).toBe('2026-10-28');
  });

  it('always reaches past Saturday when sent early in the week', () => {
    // Tuesday send (Wed & Thu are yontiff)
    const [start, end] = getStartAndEnd(new Date(2026, 9, 20));
    expect(start.format('ddd YYYY-MM-DD')).toBe('Tue 2026-10-20');
    expect(end.format('ddd YYYY-MM-DD')).toBe('Mon 2026-10-26');
  });
});

describe('compareConfigs', () => {
  const loc = (lat: number, lon: number, name: string) =>
    ({location: new Location(lat, lon, false, 'UTC', name, 'US')}) as {location: Location};

  it('sorts east to west by longitude', () => {
    const list = [loc(0, -122, 'SF'), loc(0, 35, 'JLM'), loc(0, -74, 'NYC')];
    list.sort(compareConfigs);
    expect(list.map(x => x.location.getName())).toEqual(['JLM', 'NYC', 'SF']);
  });

  it('breaks longitude ties by latitude, then by name', () => {
    const list = [loc(40, -74, 'B'), loc(30, -74, 'Z'), loc(40, -74, 'A')];
    list.sort(compareConfigs);
    expect(list.map(x => x.location.getName())).toEqual(['Z', 'A', 'B']);
  });
});

describe('formatSentLogLine', () => {
  const info = {messageId: '<abc.123@hebcal.com>', response: '250 2.0.0 Ok: queued'};

  it('records message id, acceptance, address, and location key', () => {
    expect(formatSentLogLine({email: 'a@example.com', zip: '94103'}, info)).toEqual([
      'abc.123:1:a@example.com:94103\n',
      true,
    ]);
  });

  it('prefers zip, then geonameid, then legacy city', () => {
    const cfg = {email: 'a@example.com', geonameid: 281184, legacyCity: 'Jerusalem'};
    expect(formatSentLogLine(cfg, info)[0]).toBe('abc.123:1:a@example.com:281184\n');
    expect(formatSentLogLine({email: 'a@example.com', legacyCity: 'Jerusalem'}, info)[0]).toBe(
      'abc.123:1:a@example.com:Jerusalem\n'
    );
  });

  it('marks non-250 and missing responses as not accepted', () => {
    const cfg = {email: 'a@example.com', zip: '94103'};
    expect(formatSentLogLine(cfg, {...info, response: '451 4.7.1 Try again'})).toEqual([
      'abc.123:0:a@example.com:94103\n',
      false,
    ]);
    expect(formatSentLogLine(cfg, {messageId: info.messageId})[1]).toBe(false);
  });
});

describe('parseSentLog', () => {
  it('returns only accepted addresses and tolerates blank lines', () => {
    const log =
      'abc.1:1:a@example.com:94103\n' +
      'abc.2:0:b@example.com:94103\n' +
      '\n' +
      'abc.3:1:c@example.com:Jerusalem\n';
    expect(parseSentLog(log)).toEqual(new Set(['a@example.com', 'c@example.com']));
  });

  it('returns an empty set for an empty log', () => {
    expect(parseSentLog('').size).toBe(0);
  });

  it('round-trips with formatSentLogLine', () => {
    const ok = {messageId: '<m1@hebcal.com>', response: '250 Ok'};
    const fail = {messageId: '<m2@hebcal.com>', response: '550 Rejected'};
    const log =
      formatSentLogLine({email: 'ok@example.com', geonameid: 5391959}, ok)[0] +
      formatSentLogLine({email: 'fail@example.com', zip: '94103'}, fail)[0];
    expect(parseSentLog(log)).toEqual(new Set(['ok@example.com']));
  });
});

describe('makeSubjectAndBody', () => {
  it('renders an ordinary week in plain text', () => {
    const [subject, body] = render('2026-10-22');
    expect(subject).toBe('🕯️ Lech-Lecha - San Francisco candles 6:03pm');
    expect(body).toBe(
      'Friday, October 23\n' +
        '  Candle lighting is at 6:03pm\n' +
        '\n' +
        'Saturday, October 24\n' +
        '  Torah portion: Parashat Lech-Lecha\n' +
        '  Havdalah (50 min) is at 7:10pm\n' +
        '\n' +
        'Sunday, October 25\n' +
        '  Latest Kiddush Levana at 6:09am\n'
    );
  });

  it('renders HTML with date headers, tracked parsha link, and bold times', () => {
    const html = render('2026-10-22')[2];
    expect(html).toMatch(/^<div style="font-size:14px;[^"]*">Friday, October 23<\/div>\n/);
    expect(html).toContain('Candle lighting is at <strong>6:03pm</strong></div>');
    expect(html).toContain(
      'Torah portion: <a href="https://hebcal.com/s/5787/3?us=newsletter&amp;um=email&amp;uc=shabbat-weekly">Parashat Lech-Lecha</a>'
    );
    // a spacer between days, but not before the first one
    expect(html.match(/<div>&nbsp;<\/div>/g)).toHaveLength(2);
    expect(html).toContain('Latest Kiddush Levana at <strong>6:09am</strong> 🌔</div>');
  });

  it('omits Kiddush Levana when Havdalah is disabled', () => {
    const [, body] = render('2026-10-22', makeCfg({m: 0}));
    expect(body).not.toContain('Kiddush Levana');
  });

  it('uses the holiday name in the subject when Yom Tov displaces the parsha', () => {
    const [subject, body, html] = render('2026-09-24');
    expect(subject).toBe('🕯️ Sukkot - San Francisco candles 6:43pm');
    expect(body).not.toContain('Torah portion');
    expect(body).toContain('Saturday, September 26\n  Sukkot I\n  Candle lighting is at 7:50pm\n');
    expect(html).toContain(
      '<a href="https://hebcal.com/h/sukkot-2026?us=newsletter&amp;um=email&amp;uc=shabbat-weekly">Sukkot I</a> 🌿🍋</div>'
    );
  });

  it('subject shows the first candle lighting, not a Chanukah candle time', () => {
    const [subject, body, html] = render('2026-12-03');
    expect(subject).toBe('🕯️ Vayeshev - San Francisco candles 4:32pm');
    expect(body).toContain('  Chanukah: 1 Candle at 4:32pm\n');
    expect(body).toContain('  Shabbat Mevarchim Chodesh Tevet\n');
    // Chanukah candles get their emoji; ordinary candle lighting does not
    expect(html).toContain('Chanukah: 1 Candle at <strong>4:32pm</strong> 🕎1️⃣</div>');
    expect(html).toContain('Candle lighting is at <strong>4:32pm</strong></div>');
    // a holiday without a URL is rendered as plain text
    expect(html).toContain('margin-bottom:2px">Shabbat Mevarchim Chodesh Tevet</div>');
  });

  it('uses 24-hour times and Israel URLs in Israel', () => {
    const [subject, body, html] = render(
      '2026-10-22',
      makeCfg({location: jerusalem, zip: undefined})
    );
    expect(subject).toBe('🕯️ Lech-Lecha - Jerusalem candles 17:18');
    expect(body).toContain('  Candle lighting is at 17:18\n');
    expect(html).toContain('https://hebcal.com/s/5787i/3?');
    expect(html).toContain('https://hebcal.com/h/yitzhak-rabin-memorial-day-2026?i=on&amp;');
  });

  it('passes the announcement through to the special note', () => {
    const today = dayjs('2026-10-22');
    const cfg = makeCfg();
    const [start, end] = getStartAndEnd(today.toDate());
    const options = makeCalOptions(cfg, start.toDate(), end.toDate());
    const [, , , html, text] = makeSubjectAndBody(calendar(options), options, cfg, today, {
      html: '<b>Hello</b> world',
    });
    expect(html).toContain('<b>Hello</b> world');
    expect(text).toContain('Hello world');
    const [, , , html2, text2] = makeSubjectAndBody(calendar(options), options, cfg, today);
    expect(html2).toBe('');
    expect(text2).toBe('');
  });
});
