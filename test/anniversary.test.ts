import dayjs from 'dayjs';
import {describe, expect, it, vi} from 'vitest';
import {
  calculateAnniversaryNth,
  computeAnniversary,
  getAnniversaryName,
  getAnniversaryType,
  getDateForId,
  getMaxYahrzeitId,
  getThisHebrewYear,
  getYahrzeitDetailForId,
  lightCandlesWhen,
  makeMessage,
  makeSubject,
  RawYahrzeitContents,
  SubInfo,
} from '../src/anniversary.js';

const TODAY = dayjs('2026-10-10');

/** Builds a fully computed SubInfo for entry `num` as yahrzeit_email would. */
function makeInfo(contents: RawYahrzeitContents, num = 1, hyear = 5787): SubInfo {
  const base = getYahrzeitDetailForId(contents, num)!;
  expect(base).not.toBeNull();
  const info: SubInfo = {
    ...base,
    id: 'sub123',
    anniversaryId: `sub123.${hyear}.${base.hash}.${num}`,
    hyear,
    calendarId: 'cal456',
    emailAddress: 'user@example.com',
    reminderDays: 7,
  };
  computeAnniversary(info, TODAY);
  return info;
}

describe('getAnniversaryType', () => {
  it('maps the first letter, case-insensitively', () => {
    expect(getAnniversaryType('Yahrzeit')).toBe('Yahrzeit');
    expect(getAnniversaryType('birthday')).toBe('Birthday');
    expect(getAnniversaryType('ANNIVERSARY')).toBe('Anniversary');
    expect(getAnniversaryType('other')).toBe('Other');
  });

  it('defaults to Yahrzeit for missing or unknown values', () => {
    expect(getAnniversaryType(undefined as unknown as string)).toBe('Yahrzeit');
    expect(getAnniversaryType('')).toBe('Yahrzeit');
    expect(getAnniversaryType('zzz')).toBe('Yahrzeit');
  });
});

describe('getAnniversaryName', () => {
  it('trims the stored name', () => {
    expect(getAnniversaryName({n1: '  Sarah bat Avraham '}, 1, 'Yahrzeit')).toBe(
      'Sarah bat Avraham'
    );
  });

  it('falls back to Person<N>, or Untitled<N> for Other', () => {
    expect(getAnniversaryName({}, 3, 'Yahrzeit')).toBe('Person3');
    expect(getAnniversaryName({n2: '   '}, 2, 'Birthday')).toBe('Person2');
    expect(getAnniversaryName({}, 4, 'Other')).toBe('Untitled4');
  });
});

describe('getDateForId', () => {
  it('parses an x<N> ISO date and strips leading zeros', () => {
    expect(getDateForId({x1: '2010-03-05'}, 1)).toEqual({yy: '2010', mm: '3', dd: '5'});
    expect(getDateForId({x2: '1999-11-20'}, 2)).toEqual({yy: '1999', mm: '11', dd: '20'});
  });

  it('falls back to separate y/m/d fields', () => {
    expect(getDateForId({y1: '1980', m1: '7', d1: '4'}, 1)).toEqual({yy: '1980', mm: '7', dd: '4'});
  });

  it('ignores an x<N> value that is not exactly YYYY-MM-DD length', () => {
    expect(getDateForId({x1: '2010-3-5', y1: '1980', m1: '7', d1: '4'}, 1)).toEqual({
      yy: '1980',
      mm: '7',
      dd: '4',
    });
  });
});

describe('getMaxYahrzeitId', () => {
  it('returns 0 when there are no entries', () => {
    expect(getMaxYahrzeitId({})).toBe(0);
  });

  it('finds the highest numbered entry across x and y keys', () => {
    expect(
      getMaxYahrzeitId({
        x1: '2010-03-05',
        y2: '1980',
        m2: '7',
        d2: '4',
        x7: '2001-01-01',
      })
    ).toBe(7);
  });

  it('skips blank entries and y entries missing a month or day', () => {
    expect(getMaxYahrzeitId({x1: '2010-03-05', x9: ''})).toBe(1);
    expect(getMaxYahrzeitId({x1: '2010-03-05', y5: '1980', m5: '7'})).toBe(1);
    expect(getMaxYahrzeitId({x1: '2010-03-05', y5: '1980', d5: '4'})).toBe(1);
  });

  it('ignores non-numeric keys that happen to start with x or y', () => {
    expect(getMaxYahrzeitId({x1: '2010-03-05', yy: '1980', xtra: 'zzz'})).toBe(1);
  });
});

describe('getYahrzeitDetailForId', () => {
  it('returns null for a missing entry', () => {
    expect(getYahrzeitDetailForId({}, 1)).toBeNull();
    expect(getYahrzeitDetailForId({y1: '1980', m1: '7'}, 1)).toBeNull();
  });

  it('returns null and warns for an unparseable date', () => {
    const logger = {warn: vi.fn()};
    expect(getYahrzeitDetailForId({y1: 'abc', m1: '7', d1: '4'}, 1, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('parses the entry with type and name defaults', () => {
    const info = getYahrzeitDetailForId({x2: '2010-03-15'}, 2)!;
    expect(info.num).toBe(2);
    expect(info.type).toBe('Yahrzeit');
    expect(info.name).toBe('Person2');
    expect(info.day.format('YYYY-MM-DD')).toBe('2010-03-15');
    expect(info.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('moves the date forward a day when the death was after sunset', () => {
    for (const sunset of ['on', '1', 1]) {
      const info = getYahrzeitDetailForId({x1: '2010-03-15', s1: sunset}, 1)!;
      expect(info.day.format('YYYY-MM-DD')).toBe('2010-03-16');
    }
    const before = getYahrzeitDetailForId({x1: '2010-03-15', s1: 'off'}, 1)!;
    expect(before.day.format('YYYY-MM-DD')).toBe('2010-03-15');
  });

  it('hashes on effective date and type, not on name or entry number', () => {
    const a = getYahrzeitDetailForId({x1: '2010-03-15', n1: 'A'}, 1)!;
    const b = getYahrzeitDetailForId({x3: '2010-03-15', n3: 'B'}, 3)!;
    expect(a.hash).toBe(b.hash);
    // after-sunset on the 14th is the same effective day as the 15th
    const c = getYahrzeitDetailForId({x1: '2010-03-14', s1: 'on'}, 1)!;
    expect(c.hash).toBe(a.hash);
    const birthday = getYahrzeitDetailForId({x1: '2010-03-15', t1: 'Birthday'}, 1)!;
    expect(birthday.hash).not.toBe(a.hash);
  });
});

describe('calculateAnniversaryNth', () => {
  it('counts Hebrew years since the original date', () => {
    // 15 March 2010 is in Hebrew year 5770
    expect(calculateAnniversaryNth(new Date(2010, 2, 15), 5787)).toBe('17th');
    expect(calculateAnniversaryNth(new Date(2010, 2, 15), 5771)).toBe('1st');
    expect(calculateAnniversaryNth(new Date(2010, 2, 15), 5772)).toBe('2nd');
  });
});

describe('makeSubject', () => {
  it('collapses the month when erev and the day share one', () => {
    expect(makeSubject('Yahrzeit', dayjs('2027-03-08'))).toBe('Yahrzeit Observance for March 7-8');
  });

  it('spells out both months across a month boundary', () => {
    expect(makeSubject('Hebrew Birthday', dayjs('2027-05-01'))).toBe(
      'Hebrew Birthday Observance for April 30-May 1'
    );
  });
});

describe('lightCandlesWhen', () => {
  it('varies with the day of week of erev', () => {
    expect(lightCandlesWhen(5)).toBe('before sundown');
    expect(lightCandlesWhen(6)).toBe('at nightfall');
    for (const dow of [0, 1, 2, 3, 4]) {
      expect(lightCandlesWhen(dow)).toBe('at dusk');
    }
  });
});

describe('getThisHebrewYear', () => {
  it('returns just the current year outside Elul', () => {
    expect(getThisHebrewYear(dayjs('2026-10-10'))).toEqual([5787]);
  });

  it('includes next year during Elul, so early Tishrei anniversaries are caught', () => {
    // 1 September 2026 is 19 Elul 5786
    expect(getThisHebrewYear(dayjs('2026-09-01'))).toEqual([5786, 5787]);
  });
});

describe('computeAnniversary', () => {
  it('fills in the observed date, Hebrew date and days from today', () => {
    const info = makeInfo({x1: '2010-03-15'});
    expect((info.observed as dayjs.Dayjs).format('YYYY-MM-DD')).toBe('2027-03-08');
    expect(info.hd!.render('en')).toBe('29th of Adar I, 5787');
    expect(info.diff).toBe(149);
  });

  it('marks observed false when there is no anniversary that Hebrew year', () => {
    // 5770 is the year of the original date itself
    const info = makeInfo({x1: '2010-03-15'}, 1, 5770);
    expect(info.observed).toBe(false);
    expect(info.diff).toBeUndefined();
  });
});

describe('makeMessage', () => {
  it('builds a Yahrzeit reminder with list headers and an .ics invite', () => {
    // observed Friday 30 April 2027, so erev is a Thursday
    const info = makeInfo({x1: '2010-04-07', n1: 'Sarah', t1: 'Yahrzeit'});
    const msg = makeMessage(info);
    expect(msg.subject).toBe('Yahrzeit Observance for April 29-30');
    expect(msg.to).toBe('user@example.com');
    expect(msg.messageId).toMatch(new RegExp(`^<${info.anniversaryId}\\.[0-9a-z]+@hebcal.com>$`));
    const headers = msg.headers as Record<string, string>;
    expect(headers['Return-Path']).toBe(`yahrzeit-return+sub123.${info.hash}.1@hebcal.com`);
    expect(headers['List-Id']).toBe('<sub123.list-id.hebcal.com>');
    expect(headers['List-Unsubscribe']).toBe(
      `<https://www.hebcal.com/yahrzeit/email?id=sub123&hash=${info.hash}&num=1&unsubscribe=1&commit=1&cfg=json>`
    );

    const html = msg.html as string;
    expect(html).toContain('Hebcal joins you in remembering Sarah, whose 17th Yahrzeit occurs on');
    expect(html).toContain('<time datetime="2027-04-30"');
    expect(html).toContain('light a memorial candle at dusk on');
    expect(html).toContain('<time datetime="2027-04-29"');
    expect(html).toContain('May your loved one’s soul be bound up');
    expect(html).toContain('utm_campaign=yahrzeit-reminder');
    expect(html).toContain('/yahrzeit/edit/cal456?');
    expect(html).toContain(
      `<a href="https://www.hebcal.com/yahrzeit/email?id=sub123&amp;hash=${info.hash}&amp;num=1&amp;unsubscribe=1&amp;cfg=html&amp;utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=yahrzeit-reminder">Unsubscribe</a>`
    );
    // every ampersand in a link or image URL is escaped
    for (const [, url] of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      expect(url).not.toMatch(/&(?!amp;)/);
    }

    expect(msg.attachments).toHaveLength(1);
    const ics = msg.attachments![0];
    expect(ics.filename).toBe('invite.ics');
    expect(ics.contentType).toBe('text/calendar; charset=utf-8');
    const content = ics.content as string;
    expect(content).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(content).toMatch(/\r\nEND:VCALENDAR\r\n$/);
    expect(content).toContain('SUMMARY:Sarah Yahrzeit reminder');
    expect(content).toContain('DTSTART:20270429T163000');
    expect(content).toContain(`UID:reminder-${info.anniversaryId}`);
  });

  it('says "before sundown" and reminds earlier when erev is Friday', () => {
    // observed Saturday 24 April 2027
    const msg = makeMessage(makeInfo({x1: '2010-04-01'}));
    expect(msg.html).toContain('light a memorial candle before sundown on');
    expect(msg.attachments![0].content).toContain('DTSTART:20270423T143000');
  });

  it('says "at nightfall" and reminds later when erev is Saturday', () => {
    // observed Sunday 25 April 2027
    const msg = makeMessage(makeInfo({x1: '2010-04-02'}));
    expect(msg.html).toContain('light a memorial candle at nightfall on');
    expect(msg.attachments![0].content).toContain('DTSTART:20270424T200000');
  });

  it('builds a Hebrew Birthday reminder without an invite', () => {
    const msg = makeMessage(makeInfo({x1: '1990-12-05', s1: 'on', t1: 'Birthday', n1: 'Noam'}));
    expect(msg.subject).toBe('Hebrew Birthday Observance for November 28-29');
    const html = msg.html as string;
    expect(html).toContain('Hebcal joins you in honoring Noam, whose 36th Hebrew Birthday occurs');
    expect(html).toContain('Mazal Tov!');
    expect(html).not.toContain('memorial candle');
    expect(html).toContain('utm_campaign=birthday-reminder');
    expect(msg.attachments).toBeUndefined();
  });

  it('uses the bare name and "Hebrew Anniversary" for Other', () => {
    const msg = makeMessage(makeInfo({x1: '2001-06-20', t1: 'Other'}));
    expect(msg.subject).toBe('Hebrew Anniversary Observance for July 3-4');
    const html = msg.html as string;
    expect(html).toContain('<div>Untitled1 occurs on');
    expect(html).not.toContain('Hebcal joins you');
    expect(html).not.toContain('Mazal Tov');
    expect(html).toContain('Edit Hebrew Anniversary');
    expect(msg.attachments).toBeUndefined();
  });

  it('omits Reply-To for Apple private relay recipients', () => {
    const info = makeInfo({x1: '2010-04-07'});
    info.emailAddress = 'abc@privaterelay.appleid.com';
    expect(makeMessage(info)).not.toHaveProperty('replyTo');
  });
});
