import {describe, expect, it} from 'vitest';
import {
  getLogLevel,
  makeListMessage,
  normalizeEmailAddress,
  shouldSendEmailToday,
  translateSmtpStatus,
} from '../src/common.js';
import dayjs from 'dayjs';

describe('getLogLevel', () => {
  it('maps --verbose to debug, --quiet to warn, and defaults to info', () => {
    expect(getLogLevel({verbose: true})).toBe('debug');
    expect(getLogLevel({quiet: true})).toBe('warn');
    expect(getLogLevel({})).toBe('info');
  });

  it('prefers debug when both verbose and quiet are set', () => {
    expect(getLogLevel({verbose: true, quiet: true})).toBe('debug');
  });
});

describe('translateSmtpStatus', () => {
  it('maps known SMTP status codes to standardized reasons', () => {
    expect(translateSmtpStatus('5.1.1')).toBe('user_unknown');
    expect(translateSmtpStatus('5.4.4')).toBe('domain_error');
    expect(translateSmtpStatus('5.2.1')).toBe('user_disabled');
    expect(translateSmtpStatus('552')).toBe('over_quota');
    expect(translateSmtpStatus('550')).toBe('spam');
  });

  it('returns unknown for unrecognized codes', () => {
    expect(translateSmtpStatus('2.0.0')).toBe('unknown');
    expect(translateSmtpStatus('')).toBe('unknown');
  });
});

describe('normalizeEmailAddress', () => {
  it('passes a bare address through unchanged', () => {
    expect(normalizeEmailAddress('user@example.com')).toBe('user@example.com');
  });

  it('extracts the address from a "Display Name" <addr> mailbox', () => {
    expect(normalizeEmailAddress('"Jon M. Levinson" <jonlevinson@verizon.net>')).toBe(
      'jonlevinson@verizon.net'
    );
    expect(normalizeEmailAddress('Ed Geil <eddaytona@yahoo.com>')).toBe('eddaytona@yahoo.com');
  });

  it('extracts the address when the display name is an RFC 2047 encoded-word', () => {
    expect(normalizeEmailAddress('=?UTF-8?B?15DXmdeq157XqCDXntep15Q=?= <6388326@gmail.com>')).toBe(
      '6388326@gmail.com'
    );
  });

  it('lower-cases and trims', () => {
    expect(normalizeEmailAddress('  User@Example.COM  ')).toBe('user@example.com');
    expect(normalizeEmailAddress('Name <User@Example.com>')).toBe('user@example.com');
  });
});

describe('shouldSendEmailToday', () => {
  it('never sends on a plain Sunday', () => {
    const sunday = dayjs('2026-08-02');
    expect(sunday.day()).toBe(0);
    expect(shouldSendEmailToday(sunday)).toBe(false);
  });

  it('sends on an ordinary Thursday that is not a holiday', () => {
    const thursday = dayjs('2026-08-06');
    expect(thursday.day()).toBe(4);
    expect(shouldSendEmailToday(thursday)).toBe(true);
  });
});

describe('makeListMessage', () => {
  const base = {
    subject: 'Test',
    msgid: 'abc123',
    returnPath: 'shabbat-return+x=example.com@hebcal.com',
    listId: '<shabbat.hebcal.com>',
    listUnsubscribe: '<https://www.hebcal.com/email?unsubscribe=1>',
    html: '<p>hi</p>',
  };

  it('builds common headers', () => {
    const msg = makeListMessage({...base, to: 'user@example.com', text: 'hi'});
    expect(msg).toEqual({
      from: 'Hebcal <shabbat-owner@hebcal.com>',
      replyTo: 'no-reply@hebcal.com',
      to: 'user@example.com',
      subject: 'Test',
      messageId: '<abc123@hebcal.com>',
      headers: {
        'Return-Path': base.returnPath,
        'Errors-To': base.returnPath,
        'List-Id': '<shabbat.hebcal.com>',
        'List-Unsubscribe': base.listUnsubscribe,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      html: '<p>hi</p>',
      text: 'hi',
    });
  });

  it('omits text when not provided', () => {
    const msg = makeListMessage({...base, to: 'user@example.com'});
    expect(msg).not.toHaveProperty('text');
  });

  it('omits replyTo for Apple private relay addresses', () => {
    const msg = makeListMessage({...base, to: 'xyz123@privaterelay.appleid.com'});
    expect(msg).not.toHaveProperty('replyTo');
    const msg2 = makeListMessage({...base, to: 'xyz123@PrivateRelay.AppleID.com'});
    expect(msg2).not.toHaveProperty('replyTo');
  });
});
