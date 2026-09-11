import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {Logger} from 'pino';

/**
 * Prometheus metrics for the cron jobs in this repo, exported through the
 * node_exporter *textfile collector* rather than an HTTP endpoint.
 *
 * Why a textfile and not a /metrics endpoint: these are short-lived cron
 * processes. Most of them are not running when Prometheus scrapes, so there is
 * nothing to pull from; the usual answer (a Pushgateway) would be a new daemon,
 * a new port and a new firewall hole on the mail host to carry a few dozen
 * series. Every hebcal droplet already runs node_exporter with the textfile
 * collector enabled, so a file dropped in its directory arrives on the existing
 * `digitalocean` job at :9100 with the same `instance` label as every other
 * host metric -- no scrape config, no tag, no new listening socket. This is the
 * same mechanism hebcal-devops uses for fail2ban.
 *
 * Why SQLite in between: a counter has to be monotonic *across process runs*,
 * and each cron invocation is a fresh process that knows only its own deltas.
 * Re-parsing the previous .prom file to recover the running totals would be
 * both fragile and racy -- `shabbat_bounce_sqs.js` runs every five minutes and
 * can easily overlap an hour-long `shabbat_weekly.js` send. So the durable
 * totals live in one small SQLite database, updated inside a transaction, and
 * the .prom file is a rendering of it. `node:sqlite` (DatabaseSync) is used
 * deliberately: it is in the standard library, so this adds no dependency.
 *
 * Only ONE .prom file is written (`hebcal_email.prom`), by whichever job ran
 * last. Because every writer renders the complete database rather than its own
 * slice, a lost race is harmless -- both writers produce a complete, current
 * file and the loser's content is identical apart from its own deltas. The
 * render is written to a temp file in the same directory and renamed into
 * place, because node_exporter reading a half-written file fails the *entire*
 * textfile collector, not just these metrics.
 */

/** Where node_exporter's textfile collector reads from. */
const DEFAULT_TEXTFILE_DIR = '/var/lib/prometheus/node-exporter';

/** Durable home of the cross-run counter totals. */
const DEFAULT_STATE_DIR = '/var/lib/hebcal-email';

const PROM_FILENAME = 'hebcal_email.prom';
const DB_FILENAME = 'metrics.sqlite3';

type MetricType = 'counter' | 'gauge';

type MetricDef = {
  type: MetricType;
  help: string;
};

/**
 * The complete catalog of series these jobs export. Both the writers and the
 * renderer key off this, so a metric that is not declared here is never
 * written -- which is what keeps a typo'd name from quietly becoming a new
 * time series.
 */
export const METRICS: Record<string, MetricDef> = {
  // ---- job plumbing, emitted by every script ------------------------------
  hebcal_email_job_runs_total: {
    type: 'counter',
    help: 'Cron job invocations by outcome (success, failure, or skipped because today is not a mailing day).',
  },
  hebcal_email_job_last_run_timestamp_seconds: {
    type: 'gauge',
    help: 'Unix timestamp when this job last finished, whatever the outcome.',
  },
  hebcal_email_job_last_success_timestamp_seconds: {
    type: 'gauge',
    help: 'Unix timestamp when this job last finished without throwing. Alert on the age of this, not on the absence of the job.',
  },
  hebcal_email_job_duration_seconds: {
    type: 'gauge',
    help: 'Wall-clock seconds the most recent run of this job took.',
  },

  // ---- shabbat_weekly.js --------------------------------------------------
  hebcal_email_shabbat_sent_total: {
    type: 'counter',
    help: 'Weekly Shabbat newsletters accepted by the SMTP relay (a 250 response).',
  },
  hebcal_email_shabbat_send_failures_total: {
    type: 'counter',
    help: 'Weekly Shabbat newsletters the SMTP relay did not accept.',
  },
  hebcal_email_shabbat_subscribers_loaded: {
    type: 'gauge',
    help: 'Rows with email_status=active read from hebcal_shabbat_email on the last run.',
  },
  hebcal_email_shabbat_recipients: {
    type: 'gauge',
    help: 'Recipients the last run actually queued, after the already-sent log and any --positive/--negative longitude filter.',
  },
  hebcal_email_shabbat_skipped_already_sent: {
    type: 'gauge',
    help: 'Recipients the last run skipped because an earlier run this week already mailed them.',
  },
  hebcal_email_shabbat_config_failures_total: {
    type: 'counter',
    help: 'Subscriptions dropped before sending because their stored location could not be resolved.',
  },

  // ---- yahrzeit_email.js --------------------------------------------------
  hebcal_email_yahrzeit_sent_total: {
    type: 'counter',
    help: 'Yahrzeit, Hebrew birthday and Hebrew anniversary reminders sent, by anniversary type and how many days ahead the reminder is.',
  },
  hebcal_email_yahrzeit_send_failures_total: {
    type: 'counter',
    help: 'Yahrzeit and anniversary reminders that threw while sending.',
  },
  hebcal_email_yahrzeit_subscriptions_loaded: {
    type: 'gauge',
    help: 'Rows with sub_status=active read from yahrzeit_email on the last run.',
  },
  hebcal_email_yahrzeit_reminders_due: {
    type: 'gauge',
    help: 'Reminders the last run found due, i.e. the number of messages it was about to send.',
  },
  hebcal_email_yahrzeit_optout_rules: {
    type: 'gauge',
    help: 'Active rows in yahrzeit_optout as of the last run.',
  },

  // ---- shabbat_bounce_sqs.js ----------------------------------------------
  hebcal_email_sqs_messages_total: {
    type: 'counter',
    help: 'SES notifications drained from SQS, by queue (bounce or unsub).',
  },
  hebcal_email_bounces_total: {
    type: 'counter',
    help: 'Bounce and complaint notifications recorded in hebcal_shabbat_bounce, by std_reason.',
  },
  hebcal_email_bounce_notifications_ignored_total: {
    type: 'counter',
    help: 'Messages on the bounce queue that were neither a Bounce nor a Complaint and were dropped.',
  },
  hebcal_email_unsubscribes_total: {
    type: 'counter',
    help: 'Inbound unsubscribe emails by outcome: unsub (honored), unsub_twice (already unsubscribed), unsub_notfound (address not on the list).',
  },

  // ---- shabbat_deactivate.js ----------------------------------------------
  hebcal_email_deactivated_total: {
    type: 'counter',
    help: 'Subscriptions deactivated for chronic bouncing, counted once per address and attributed to the bounce reason that tripped the threshold.',
  },
  hebcal_email_deactivate_candidates: {
    type: 'gauge',
    help: 'Addresses the last run deactivated. Compare with hebcal_email_bounces_pending_deactivation to see the backlog it worked from.',
  },

  // ---- data_retention.js --------------------------------------------------
  hebcal_email_retention_rows_deleted_total: {
    type: 'counter',
    help: 'Rows deleted by the nightly data-retention purge, by table.',
  },
  hebcal_email_retention_rows_expired: {
    type: 'gauge',
    help: 'Rows the last purge found older than the retention window, by table. Should return to roughly a single day of arrivals after every successful run.',
  },

  // ---- metrics_textfile.js (the systemd timer) ----------------------------
  hebcal_email_subscribers: {
    type: 'gauge',
    help: 'Current subscriber count by list and subscription status, straight from MySQL.',
  },
  hebcal_email_bounce_table_rows: {
    type: 'gauge',
    help: 'Total rows in hebcal_shabbat_bounce. Bounded by the data-retention purge.',
  },
  hebcal_email_bounces_pending_deactivation: {
    type: 'gauge',
    help: 'Bounce rows from the last 365 days that have not been deactivated yet, by std_reason -- the pool shabbat_deactivate.js scans.',
  },
};

export type Labels = Record<string, string | number>;

/**
 * Canonical serialization of a label set: sorted by name so that the same
 * labels always hash to the same primary key, whatever order the caller
 * happened to pass them in.
 */
function serializeLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '';
  }
  return keys.map(k => `${k}="${escapeLabelValue(String(labels[k]))}"`).join(',');
}

/** Escapes a label value per the Prometheus text exposition format. */
function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/** Escapes the free text of a `# HELP` line, where only \ and newline matter. */
function escapeHelp(help: string): string {
  return help.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

type Sample = {name: string; labels: string; value: number};

/**
 * Renders the whole database as a Prometheus text-format exposition. Samples
 * are ordered by name then label set so that the file only changes when the
 * numbers do, which makes a diff of two consecutive renders readable.
 */
export function renderProm(samples: Sample[]): string {
  const byName = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (!METRICS[sample.name]) {
      continue; // dropped: not in the catalog, so we have no HELP/TYPE for it
    }
    const group = byName.get(sample.name);
    if (group) {
      group.push(sample);
    } else {
      byName.set(sample.name, [sample]);
    }
  }
  const lines: string[] = [];
  for (const name of Array.from(byName.keys()).sort()) {
    const def = METRICS[name];
    const group = byName.get(name)!;
    group.sort((a, b) => a.labels.localeCompare(b.labels));
    lines.push(`# HELP ${name} ${escapeHelp(def.help)}`);
    lines.push(`# TYPE ${name} ${def.type}`);
    for (const sample of group) {
      const labels = sample.labels ? `{${sample.labels}}` : '';
      lines.push(`${name}${labels} ${formatValue(sample.value)}`);
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/**
 * Prometheus wants a plain decimal; JS would render large or tiny values in
 * exponential notation, which the text format does accept but which makes the
 * file annoying to eyeball. Integers (everything here, in practice) stay
 * integers.
 */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? '+Inf' : value < 0 ? '-Inf' : 'NaN';
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

export type MetricsOptions = {
  logger: Logger;
  /** Set false for --dryrun: build the numbers, persist nothing. */
  enabled?: boolean;
  /** Overrides for tests; production uses the defaults above. */
  stateDir?: string;
  textfileDir?: string;
};

/**
 * Per-job metric recorder. Deltas accumulate in memory and are folded into the
 * SQLite totals on `flush()` / `finish()`, so a 30k-message send does one
 * transaction instead of 30k.
 *
 * Nothing here is allowed to take a job down: every filesystem and database
 * operation is wrapped, and a failure disables the recorder for the rest of the
 * run after one warning.
 */
export class Metrics {
  private readonly job: string;
  private readonly logger: Logger;
  private readonly stateDir: string;
  private readonly textfileDir: string;
  private readonly counters = new Map<string, {name: string; labels: string; delta: number}>();
  private readonly gauges = new Map<string, {name: string; labels: string; value: number}>();
  private readonly startedAt = Date.now();
  private enabled: boolean;

  constructor(job: string, opts: MetricsOptions) {
    this.job = job;
    this.logger = opts.logger;
    this.enabled = opts.enabled ?? true;
    this.stateDir = opts.stateDir ?? process.env.HEBCAL_METRICS_STATE_DIR ?? DEFAULT_STATE_DIR;
    this.textfileDir =
      opts.textfileDir ?? process.env.HEBCAL_METRICS_TEXTFILE_DIR ?? DEFAULT_TEXTFILE_DIR;
  }

  /** Adds to a counter. Unknown metric names are ignored, loudly. */
  inc(name: string, labels: Labels = {}, value = 1): void {
    if (!this.checkName(name, 'counter')) {
      return;
    }
    const key = `${name}\u0000${serializeLabels(labels)}`;
    const entry = this.counters.get(key);
    if (entry) {
      entry.delta += value;
    } else {
      this.counters.set(key, {name, labels: serializeLabels(labels), delta: value});
    }
  }

  /** Sets a gauge to its current value, replacing whatever was stored before. */
  setGauge(name: string, labels: Labels, value: number): void {
    if (!this.checkName(name, 'gauge')) {
      return;
    }
    const serialized = serializeLabels(labels);
    this.gauges.set(`${name}\u0000${serialized}`, {name, labels: serialized, value});
  }

  private checkName(name: string, type: MetricType): boolean {
    const def = METRICS[name];
    if (!def) {
      this.logger.warn(`metrics: ignoring undeclared metric ${name}`);
      return false;
    }
    if (def.type !== type) {
      this.logger.warn(`metrics: ${name} is a ${def.type}, not a ${type}`);
      return false;
    }
    return true;
  }

  /**
   * Folds the accumulated deltas into SQLite and re-renders the .prom file.
   * Safe to call repeatedly mid-run -- `shabbat_weekly.js` does, so a long send
   * shows up in Grafana while it is still running rather than only at the end.
   */
  flush(): void {
    if (!this.enabled) {
      return;
    }
    if (this.counters.size === 0 && this.gauges.size === 0) {
      return;
    }
    try {
      this.persistAndRender();
      this.counters.clear();
      this.gauges.clear();
    } catch (err) {
      // Metrics are never worth failing a mail run over.
      this.logger.warn({err}, `metrics: giving up on this run. ${this.hint(err)}`);
      this.enabled = false;
    }
  }

  /**
   * Records the job-level plumbing metrics and flushes. Synchronous on
   * purpose, so it can run immediately before `process.exit()`.
   */
  finish(result: 'success' | 'failure' | 'skipped'): void {
    if (!this.enabled) {
      return;
    }
    const now = Date.now();
    const job = {job: this.job};
    this.inc('hebcal_email_job_runs_total', {job: this.job, result});
    this.setGauge('hebcal_email_job_last_run_timestamp_seconds', job, Math.floor(now / 1000));
    this.setGauge('hebcal_email_job_duration_seconds', job, (now - this.startedAt) / 1000);
    if (result === 'success') {
      this.setGauge('hebcal_email_job_last_success_timestamp_seconds', job, Math.floor(now / 1000));
    }
    this.flush();
  }

  /**
   * Turns the two failures that are configuration rather than bad luck into
   * their own fix. Both are permanent -- they will repeat on every run until
   * someone acts -- and both surface as a bare errno in a cron log that is not
   * read closely, so the log line has to carry the remedy with it.
   */
  private hint(err: unknown): string {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      return (
        `This is a permissions problem, not a transient one, and it will repeat every run: ` +
        `${this.textfileDir} must be writable by this process's user, and ` +
        `${this.stateDir} must be owned by it. On the mail host, running ` +
        `/usr/local/bin/hebcal_email_metrics_perms.sh (hebcal-devops) as root repairs both; ` +
        `if it reports a missing group, that is the cause.`
      );
    }
    if (code === 'ENOSPC') {
      return 'The filesystem is full; no metrics will be recorded until space is freed.';
    }
    return 'Set HEBCAL_METRICS_TEXTFILE_DIR / HEBCAL_METRICS_STATE_DIR to relocate these files.';
  }

  private persistAndRender(): void {
    fs.mkdirSync(this.stateDir, {recursive: true});
    const db = new DatabaseSync(path.join(this.stateDir, DB_FILENAME));
    try {
      // WAL plus a busy timeout is what lets the five-minute SQS drain write
      // while an hour-long weekly send is also writing.
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec(`CREATE TABLE IF NOT EXISTS counters (
  name TEXT NOT NULL,
  labels TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (name, labels)
)`);
      db.exec(`CREATE TABLE IF NOT EXISTS gauges (
  name TEXT NOT NULL,
  labels TEXT NOT NULL,
  value REAL NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (name, labels)
)`);
      const addCounter = db.prepare(`INSERT INTO counters (name, labels, value) VALUES (?, ?, ?)
  ON CONFLICT (name, labels) DO UPDATE SET value = value + excluded.value`);
      const setGauge =
        db.prepare(`INSERT INTO gauges (name, labels, value, updated) VALUES (?, ?, ?, ?)
  ON CONFLICT (name, labels) DO UPDATE SET value = excluded.value, updated = excluded.updated`);
      const updated = Math.floor(Date.now() / 1000);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const c of this.counters.values()) {
          addCounter.run(c.name, c.labels, c.delta);
        }
        for (const g of this.gauges.values()) {
          setGauge.run(g.name, g.labels, g.value, updated);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      const samples = [
        ...(db.prepare('SELECT name, labels, value FROM counters').all() as unknown as Sample[]),
        ...(db.prepare('SELECT name, labels, value FROM gauges').all() as unknown as Sample[]),
      ];
      this.writeTextfile(renderProm(samples));
    } finally {
      db.close();
    }
  }

  private writeTextfile(contents: string): void {
    fs.mkdirSync(this.textfileDir, {recursive: true});
    const out = path.join(this.textfileDir, PROM_FILENAME);
    // Same directory as the target, so the rename below is a same-filesystem
    // rename(2) and therefore atomic. The suffix deliberately is not .prom:
    // node_exporter must not try to parse the half-written file.
    const tmp = `${out}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, contents, {mode: 0o644});
      // writeFileSync's mode only applies when it creates the file; a leftover
      // temp from a killed run would keep its old mode. node_exporter reads as
      // the `prometheus` user, so 0644 is not optional.
      fs.chmodSync(tmp, 0o644);
      fs.renameSync(tmp, out);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw err;
    }
  }
}
