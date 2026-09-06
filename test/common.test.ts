import {describe, expect, it} from 'vitest';
import {
  getLogLevel,
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
