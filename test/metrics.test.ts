import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
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

  it('survives an unwritable textfile directory, and says how to fix it', () => {
    // Reproduces the EACCES seen on the mail host, where the .prom directory
    // was left root-owned 0755 and the cron jobs run as `hebcal`. Injected
    // rather than provoked with chmod, because the suite may run as root --
    // and root would simply write the file, proving nothing.
    const denied = Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw denied;
    });
    const warnings: string[] = [];
    const capturing = {
      warn: (_obj: unknown, msg?: string) => warnings.push(msg ?? String(_obj)),
    } as unknown as typeof logger;
    try {
      const m = new Metrics('shabbat_bounce_sqs', {
        logger: capturing,
        stateDir,
        textfileDir,
      });
      m.inc('hebcal_email_bounces_total', {reason: 'spam'});
      // The whole point: a metrics failure must not take a mail run down.
      expect(() => m.finish('success')).not.toThrow();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('permissions problem');
      // The remedy, not just the diagnosis: this line is the whole interface
      // between a broken deploy and whoever greps the log.
      expect(warnings[0]).toContain('install -d -o hebcal -g hebcal');
      // Disabled after the first failure: one warning per run, not one per
      // flush -- shabbat_weekly flushes every 200 messages.
      m.inc('hebcal_email_bounces_total', {reason: 'spam'});
      m.flush();
      expect(warnings).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('cleans up its temp file when the rename fails', () => {
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV: cross-device link'), {code: 'EXDEV'});
    });
    try {
      const m = new Metrics('shabbat_weekly', {logger, stateDir, textfileDir});
      m.inc('hebcal_email_shabbat_sent_total');
      m.finish('success');
    } finally {
      spy.mockRestore();
    }
    // The temp file was really written before the rename threw, so this is the
    // cleanup path and not a vacuous assertion.
    expect(fs.readdirSync(textfileDir)).toEqual([]);
  });

  it('defaults to writing somewhere these jobs can own', () => {
    // Regression guard with a history: the .prom used to default into
    // node_exporter's own directory, which belongs to the
    // prometheus-node-exporter package. dpkg restores that directory's
    // root ownership on every unpack, so the unprivileged mail jobs lost
    // write access repeatedly and silently. A root timer on the host now
    // publishes the file from here; nothing in this process should ever
    // reach into /var/lib/prometheus again.
    const m = new Metrics('shabbat_weekly', {logger});
    const paths = JSON.parse(JSON.stringify(m)) as {stateDir: string; textfileDir: string};
    expect(paths.textfileDir).not.toMatch(/^\/var\/lib\/prometheus/);
    // Both live in the one directory the jobs own, so a deploy has exactly one
    // thing to get right.
    expect(paths.textfileDir).toBe(paths.stateDir);
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
