import {HDate, Location, months} from '@hebcal/core';
import dayjs from 'dayjs';
import {describe, expect, it} from 'vitest';
import {getSpecialNote, SpecialNoteConfig} from '../src/specialNote.js';

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
