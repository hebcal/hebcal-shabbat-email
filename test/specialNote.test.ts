import {HDate, Location, months} from '@hebcal/core';
import dayjs from 'dayjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {
  Announcement,
  getSpecialNote,
  readAnnouncement,
  SpecialNoteConfig,
} from '../src/specialNote.js';

const diaspora = new Location(
  40.09,
  -75.22,
  false,
  'America/New_York',
  'Philadelphia',
  'US',
  4560349
);
const israel = new Location(31.76, 35.23, true, 'Asia/Jerusalem', 'Jerusalem', 'IL', 281184);

function makeCfg(overrides: Partial<SpecialNoteConfig> = {}): SpecialNoteConfig {
  return {location: diaspora, zip: '19003', b: 18, m: 50, td: null, ...overrides};
}

/** Returns a dayjs for the given Hebrew day/month/year. */
function hd(dd: number, mm: number, yy: number): dayjs.Dayjs {
  return dayjs(new HDate(dd, mm, yy).greg());
}

describe('getSpecialNote', () => {
  it('returns two empty strings when there is no seasonal note', () => {
    const [text, html] = getSpecialNote(makeCfg(), hd(1, months.CHESHVAN, 5787));
    expect(text).toBe('');
    expect(html).toBe('');
  });

  it('wraps HTML output in the styled div and ends text with a blank line', () => {
    const [text, html] = getSpecialNote(makeCfg(), hd(3, months.TISHREI, 5787));
    expect(html.startsWith('<div style="font-size:14px')).toBe(true);
    expect(html.trimEnd().endsWith('<div>&nbsp;</div>')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('renders the Rosh Hashana / year-at-a-glance note in Av and Elul', () => {
    for (const when of [hd(20, months.AV, 5787), hd(20, months.ELUL, 5787)]) {
      const [text, html] = getSpecialNote(makeCfg(), when);
      expect(text).toContain('Shana Tova!');
      expect(html).toContain('year-at-a-glance');
      expect(html).toContain('fridge.cgi');
    }
  });

  it('renders the Yom Kippur note between Rosh Hashana and Yom Kippur', () => {
    const [text, html] = getSpecialNote(makeCfg(), hd(3, months.TISHREI, 5787));
    expect(text).toContain('G’mar Chatima Tova!');
    expect(text).toContain('https://hebcal.com/h/yom-kippur-');
    expect(html).toContain('https://hebcal.com/h/yom-kippur-');
  });

  it('renders a Sukkot greeting during Sukkot', () => {
    const [text] = getSpecialNote(makeCfg(), hd(18, months.TISHREI, 5787));
    expect(text).toContain('Moadim L’Simcha!');
    expect(text).toContain('Sukkot');
  });

  it('renders the Purim note about a week and a half before', () => {
    const yy = 5787;
    const purimMonth = HDate.isLeapYear(yy) ? months.ADAR_II : months.ADAR_I;
    const [text, html] = getSpecialNote(makeCfg(), hd(5, purimMonth, yy));
    expect(text).toContain('Chag Purim Sameach!');
    expect(html).toContain('hebcal.com/h/purim-');
  });

  it('renders the Pesach note in the weeks before Passover', () => {
    const [text, html] = getSpecialNote(makeCfg(), hd(5, months.NISAN, 5787));
    expect(text).toContain('Chag Kasher v’Sameach!');
    expect(html).toContain('hebcal.com/h/pesach-');
  });

  it('renders the Chanukah note in early Kislev', () => {
    const [text, html] = getSpecialNote(makeCfg(), hd(5, months.KISLEV, 5787));
    expect(text).toContain('Chag Urim Sameach!');
    expect(html).toContain('hebcal.com/h/chanukah-');
  });

  it('adds UTM tracking to the HTML link but not the plain-text one', () => {
    const [text, html] = getSpecialNote(makeCfg(), hd(3, months.TISHREI, 5787));
    // HTML links are tracked (and ampersands escaped for the attribute)
    expect(html).toContain('uc=shabbat-weekly');
    expect(html).toContain('&amp;');
    // the plain-text link stays clean
    expect(text).not.toContain('uc=shabbat-weekly');
  });

  it('uses Israel-flavored URLs for an Israel location', () => {
    const [text, html] = getSpecialNote(makeCfg({location: israel}), hd(3, months.TISHREI, 5787));
    expect(text).toContain('?i=on');
    expect(html).toContain('i=on');
  });
});

describe('getSpecialNote with an announcement', () => {
  const announcement: Announcement = {
    html: 'Hebcal for Apple Watch now includes candle-lighting times. <a href="https://apps.apple.com/us/app/hebcal-hebrew-calendar/id1582733315">Download from the App Store</a> today!',
  };

  it('renders the announcement alone when there is no seasonal note', () => {
    const [text, html] = getSpecialNote(makeCfg(), hd(1, months.CHESHVAN, 5787), announcement);
    expect(html).toContain('background-color:#d9edf7');
    expect(html).toContain(
      'href="https://apps.apple.com/us/app/hebcal-hebrew-calendar/id1582733315"'
    );
    expect(html.trimEnd().endsWith('<div>&nbsp;</div>')).toBe(true);
    expect(text).toContain('Hebcal for Apple Watch');
    expect(text).toContain('https://apps.apple.com/us/app/hebcal-hebrew-calendar/id1582733315');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('appends the announcement after the seasonal note', () => {
    const [text, html] = getSpecialNote(makeCfg(), hd(3, months.TISHREI, 5787), announcement);
    expect(text.indexOf('G’mar Chatima Tova!')).toBeLessThan(
      text.indexOf('Hebcal for Apple Watch')
    );
    expect(html.indexOf('#dff0d8')).toBeLessThan(html.indexOf('#d9edf7'));
  });

  it('prefers an explicit plain-text version', () => {
    const [text] = getSpecialNote(makeCfg(), hd(1, months.CHESHVAN, 5787), {
      ...announcement,
      text: 'Plain text only',
    });
    expect(text).toBe('Plain text only\n\n');
  });
});

describe('readAnnouncement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'announcement-'));
  afterAll(() => fs.rmSync(dir, {recursive: true, force: true}));
  const today = dayjs('2026-10-15');

  function write(name: string, contents: string): string {
    const filename = path.join(dir, name);
    fs.writeFileSync(filename, contents);
    return filename;
  }

  it('returns undefined when the file does not exist', () => {
    expect(readAnnouncement(path.join(dir, 'nope.json'), today)).toBeUndefined();
  });

  it('reads a minimal announcement', () => {
    const filename = write('min.json', JSON.stringify({html: 'Hello'}));
    expect(readAnnouncement(filename, today)).toEqual({html: 'Hello'});
  });

  it('honors an inclusive start/end window', () => {
    const filename = write(
      'window.json',
      JSON.stringify({html: 'Hello', start: '2026-10-15', end: '2026-10-22'})
    );
    expect(readAnnouncement(filename, dayjs('2026-10-14'))).toBeUndefined();
    expect(readAnnouncement(filename, dayjs('2026-10-15'))?.html).toBe('Hello');
    expect(readAnnouncement(filename, dayjs('2026-10-22'))?.html).toBe('Hello');
    expect(readAnnouncement(filename, dayjs('2026-10-23'))).toBeUndefined();
  });

  it('rejects malformed files', () => {
    expect(() => readAnnouncement(write('bad.json', '{html:'), today)).toThrow();
    expect(() => readAnnouncement(write('nohtml.json', '{"text":"x"}'), today)).toThrow(/html/);
    expect(() =>
      readAnnouncement(write('baddate.json', '{"html":"x","end":"10/22/2026"}'), today)
    ).toThrow(/YYYY-MM-DD/);
  });
});
