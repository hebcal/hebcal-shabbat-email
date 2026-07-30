import {HDate, Location, months} from '@hebcal/core';
import dayjs, {Dayjs} from 'dayjs';
import {htmlToText} from 'html-to-text';
import {htmlToTextOptions} from './common.js';
import {urlEncodeAndTrack} from './tracking.js';

const FORMAT_DOW_MONTH_DAY = 'dddd, MMMM D';
const BLANK = '<div>&nbsp;</div>';

/** Subset of a subscriber config that the seasonal greeting note depends on. */
export type SpecialNoteConfig = {
  location: Location;
  zip?: string;
  geonameid?: number;
  b: number;
  m: number;
  td: number | null;
};

function nowrap(s: string): string {
  return `<span style="white-space: nowrap">${s}</span>`;
}

/**
 * Builds the seasonal greeting note in both plain-text and HTML form.
 *
 * The date logic runs a single time; only the holiday URLs differ between
 * the two output formats, so each matching branch supplies a builder that
 * renders the note given the desired URL style.
 *
 * @returns a `[text, html]` pair, both empty strings when there is no note
 */
export function getSpecialNote(cfg: SpecialNoteConfig, today: Dayjs): [string, string] {
  const hd = new HDate(today.toDate());
  const mm = hd.getMonth();
  const dd = hd.getDate();
  const yy = hd.getFullYear();
  const purimMonth = HDate.isLeapYear(yy) ? months.ADAR_II : months.ADAR_I;
  const gy = today.year();

  function makeUrl(holiday: string, isHTML: boolean): string {
    const il = cfg.location.getIsrael();
    return isHTML
      ? urlEncodeAndTrack(`https://www.hebcal.com/holidays/${holiday}-${gy}`, il)
      : `https://hebcal.com/h/${holiday}-${gy}${il ? '?i=on' : ''}`;
  }

  const shortLocation = cfg.location.getShortName();
  let buildNote: ((isHTML: boolean) => string) | undefined;
  if ((mm === months.AV && dd >= 16 && dd <= 26) || (mm === months.ELUL && dd >= 16 && dd <= 26)) {
    // for a week or two in Av and the last week or two of Elul
    const nextYear = yy + 1;
    const fridgeLoc = cfg.zip ? `zip=${cfg.zip}` : `geonameid=${cfg.geonameid}`;
    const erevRH = dayjs(new HDate(1, months.TISHREI, nextYear).prev().greg());
    const strtime = nowrap(erevRH.format(FORMAT_DOW_MONTH_DAY));
    let url = `https://www.hebcal.com/shabbat/fridge.cgi?${fridgeLoc}&b=${cfg.b}&year=${nextYear}`;
    if (cfg.m) {
      url += `&m=${cfg.m}`;
    } else if (cfg.td !== null) {
      url += `&M=on&td=${cfg.td}`;
    }
    url = urlEncodeAndTrack(url);
    const rhNameSpan = nowrap(`Rosh Hashana ${nextYear}`);
    buildNote = () => `Shana Tova! We wish you a happy and healthy New Year.
${rhNameSpan} begins at sundown on ${strtime}.
<br><br>Print your <a
style="color:#356635" href="${url}">${shortLocation} ${nextYear} year-at-a-glance</a>
for Shabbat and holiday candle-lighting times on a single page.`;
  } else if (mm === months.TISHREI && dd <= 9) {
    // between RH & YK
    const erevYK = dayjs(new HDate(9, months.TISHREI, yy).greg());
    const strtime = nowrap(erevYK.format(FORMAT_DOW_MONTH_DAY));
    buildNote = isHTML => `G’mar Chatima Tova! We wish you a good inscription in the Book of Life.
<br><a style="color:#356635" href="${makeUrl('yom-kippur', isHTML)}">Yom Kippur ${yy}</a>
begins at sundown on ${strtime}.`;
  } else if (
    (mm === months.TISHREI && dd >= 17 && dd <= 21) ||
    (mm === months.NISAN && dd >= 17 && dd <= 20)
  ) {
    const holiday = mm === months.TISHREI ? 'Sukkot' : 'Pesach';
    buildNote = () => `Moadim L’Simcha! We wish you a very happy ${holiday}.`;
  } else if (mm === purimMonth && dd >= 2 && dd <= 10) {
    // show Purim greeting 1.5 weeks before
    const erevPurim = dayjs(new HDate(13, purimMonth, yy).greg());
    const strtime = nowrap(erevPurim.format(FORMAT_DOW_MONTH_DAY));
    buildNote = isHTML => `Chag Purim Sameach!
<a style="color:#356635" href="${makeUrl('purim', isHTML)}">Purim ${yy}</a>
begins at sundown on ${strtime}.`;
  } else if (
    (mm === purimMonth && dd >= 17 && dd <= 25) ||
    (mm === months.NISAN && dd >= 2 && dd <= 9)
  ) {
    // show Pesach greeting shortly after Purim and ~2 weeks before
    const erevPesach = dayjs(new HDate(14, months.NISAN, yy).greg());
    const strtime = nowrap(erevPesach.format(FORMAT_DOW_MONTH_DAY));
    buildNote = isHTML => `Chag Kasher v’Sameach! We wish you a happy
<a style="color:#356635" href="${makeUrl('pesach', isHTML)}">Pesach ${yy}</a>.
<br>Passover begins at sundown on ${strtime}.`;
  } else if (mm === months.KISLEV && dd >= 1 && dd <= 13) {
    // for the first 2 weeks of Kislev, show Chanukah greeting
    const erevChanukah = dayjs(new HDate(24, months.KISLEV, yy).greg());
    const dow = erevChanukah.day();
    const strtime = nowrap(erevChanukah.format(FORMAT_DOW_MONTH_DAY));
    const when = dow === 5 ? 'before sundown' : dow === 6 ? 'at nightfall' : 'at sundown';
    buildNote = isHTML => `Chag Urim Sameach! Light the first
<a style="color:#356635" href="${makeUrl('chanukah', isHTML)}">Chanukah candle</a>
${when} on ${strtime}.`;
  }

  if (!buildNote) {
    return ['', ''];
  }

  const text = htmlToText(buildNote(false), htmlToTextOptions) + '\n\n';
  const html =
    '<div style="font-size:14px;font-family:arial,helvetica,sans-serif;padding:8px;color:#468847;background-color:#dff0d8;border-color:#d6e9c6;border-radius:4px">\n' +
    buildNote(true) +
    `\n</div>\n${BLANK}\n`;
  return [text, html];
}
