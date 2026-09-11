import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import {Metrics, renderProm} from '../src/metrics.js';

/** Silent logger: these tests deliberately exercise the warning paths. */
const logger = pino({level: 'silent'});

let tmpdir: string;
let stateDir: string;
let textfileDir: string;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hebcal-metrics-'));
  stateDir = path.join(tmpdir, 'state');
  textfileDir = path.join(tmpdir, 'textfile');
});

afterEach(() => {
  fs.rmSync(tmpdir, {recursive: true, force: true});
});

function makeMetrics(job: string, enabled = true): Metrics {
  return new Metrics(job, {logger, enabled, stateDir, textfileDir});
}

function readProm(): string {
  return fs.readFileSync(path.join(textfileDir, 'hebcal_email.prom'), 'utf-8');
}

describe('renderProm', () => {
  it('emits HELP and TYPE once per family, with samples sorted by label set', () => {
    const out = renderProm([
      {name: 'hebcal_email_bounces_total', labels: 'reason="spam"', value: 3},
      {name: 'hebcal_email_bounces_total', labels: 'reason="over_quota"', value: 7},
    ]);
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^# HELP hebcal_email_bounces_total /);
    expect(lines[1]).toBe('# TYPE hebcal_email_bounces_total counter');
    expect(lines.slice(2)).toEqual([
      'hebcal_email_bounces_total{reason="over_quota"} 7',
      'hebcal_email_bounces_total{reason="spam"} 3',
    ]);
  });

  it('omits the brace group for an unlabelled sample', () => {
    const out = renderProm([{name: 'hebcal_email_shabbat_sent_total', labels: '', value: 42}]);
    expect(out).toContain('\nhebcal_email_shabbat_sent_total 42\n');
  });

  it('drops samples with no catalog entry, since they have no HELP or TYPE', () => {
    const out = renderProm([{name: 'hebcal_email_bogus_total', labels: '', value: 1}]);
    expect(out).toBe('');
  });
});

describe('Metrics', () => {
  it('accumulates counters across separate runs', () => {
    const first = makeMetrics('shabbat_weekly');
    first.inc('hebcal_email_shabbat_sent_total', {}, 100);
    first.finish('success');

    const second = makeMetrics('shabbat_weekly');
    second.inc('hebcal_email_shabbat_sent_total', {}, 23);
    second.finish('success');

    expect(readProm()).toContain('\nhebcal_email_shabbat_sent_total 123\n');
  });

  it('keeps counters from different jobs in the same file', () => {
    const weekly = makeMetrics('shabbat_weekly');
    weekly.inc('hebcal_email_shabbat_sent_total', {}, 5);
    weekly.finish('success');

    const sqs = makeMetrics('shabbat_bounce_sqs');
    sqs.inc('hebcal_email_bounces_total', {reason: 'user_unknown'});
    sqs.finish('success');

    const prom = readProm();
    expect(prom).toContain('hebcal_email_shabbat_sent_total 5');
    expect(prom).toContain('hebcal_email_bounces_total{reason="user_unknown"} 1');
    expect(prom).toContain('hebcal_email_job_runs_total{job="shabbat_weekly",result="success"} 1');
    expect(prom).toContain(
      'hebcal_email_job_runs_total{job="shabbat_bounce_sqs",result="success"} 1'
    );
  });

  it('replaces a gauge rather than adding to it', () => {
    const first = makeMetrics('data_retention');
    first.setGauge('hebcal_email_retention_rows_expired', {table: 'email_open'}, 900);
    first.finish('success');

    const second = makeMetrics('data_retention');
    second.setGauge('hebcal_email_retention_rows_expired', {table: 'email_open'}, 12);
    second.finish('success');

    expect(readProm()).toContain('hebcal_email_retention_rows_expired{table="email_open"} 12\n');
  });

  it('serializes labels in a stable order regardless of how they were passed', () => {
    const m = makeMetrics('yahrzeit_email');
    m.inc('hebcal_email_yahrzeit_sent_total', {type: 'Yahrzeit', reminder_days: 7});
    m.inc('hebcal_email_yahrzeit_sent_total', {reminder_days: 7, type: 'Yahrzeit'});
    m.finish('success');

    expect(readProm()).toContain(
      'hebcal_email_yahrzeit_sent_total{reminder_days="7",type="Yahrzeit"} 2\n'
    );
  });

  it('records the job plumbing metrics, and skips last_success unless the run succeeded', () => {
    const m = makeMetrics('metrics_textfile');
    m.finish('failure');
    const prom = readProm();
    expect(prom).toContain(
      'hebcal_email_job_runs_total{job="metrics_textfile",result="failure"} 1'
    );
    expect(prom).toMatch(
      /hebcal_email_job_last_run_timestamp_seconds\{job="metrics_textfile"\} \d{10}/
    );
    expect(prom).not.toContain('hebcal_email_job_last_success_timestamp_seconds');
  });

  it('writes nothing at all when disabled for --dryrun', () => {
    const m = makeMetrics('shabbat_weekly', false);
    m.inc('hebcal_email_shabbat_sent_total', {}, 1000);
    m.finish('success');
    expect(fs.existsSync(textfileDir)).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it('ignores an undeclared metric name instead of exporting it', () => {
    const m = makeMetrics('shabbat_weekly');
    m.inc('hebcal_email_typo_total');
    m.inc('hebcal_email_shabbat_sent_total');
    m.finish('success');
    const prom = readProm();
    expect(prom).not.toContain('hebcal_email_typo_total');
    expect(prom).toContain('hebcal_email_shabbat_sent_total 1');
  });

  it('ignores a counter written to a gauge name, and vice versa', () => {
    const m = makeMetrics('shabbat_weekly');
    m.inc('hebcal_email_shabbat_recipients');
    m.setGauge('hebcal_email_shabbat_sent_total', {}, 5);
    m.finish('success');
    const prom = readProm();
    expect(prom).not.toContain('hebcal_email_shabbat_recipients');
    expect(prom).not.toContain('hebcal_email_shabbat_sent_total');
  });

  it('leaves the file world-readable and drops no temp files behind', () => {
    const m = makeMetrics('shabbat_weekly');
    m.inc('hebcal_email_shabbat_sent_total');
    m.finish('success');
    const stat = fs.statSync(path.join(textfileDir, 'hebcal_email.prom'));
    expect(stat.mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(textfileDir)).toEqual(['hebcal_email.prom']);
  });

  it('flushes mid-run so a long send is visible before it finishes', () => {
    const m = makeMetrics('shabbat_weekly');
    m.inc('hebcal_email_shabbat_sent_total', {}, 200);
    m.flush();
    expect(readProm()).toContain('hebcal_email_shabbat_sent_total 200');
    // The flushed delta must not be counted a second time by finish().
    m.inc('hebcal_email_shabbat_sent_total', {}, 1);
    m.finish('success');
    expect(readProm()).toContain('hebcal_email_shabbat_sent_total 201');
  });

  it('escapes quotes and backslashes in label values', () => {
    const m = makeMetrics('shabbat_weekly');
    m.inc('hebcal_email_shabbat_config_failures_total', {reason: 'say "hi"\\now'});
    m.finish('success');
    expect(readProm()).toContain(
      'hebcal_email_shabbat_config_failures_total{reason="say \\"hi\\"\\\\now"} 1'
    );
  });
});
