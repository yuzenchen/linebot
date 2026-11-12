/**
 * SPEC-STAFF §16 backup to the user's Google Sheet. Every run rebuilds all seven tabs from the
 * database (full overwrite, not incremental) and POSTs them as JSON to the sheet's Apps Script web
 * app (`docs/STAFF-BACKUP.md`), which checks the token, refuses a tab whose row count would drop
 * (unless `force`), and writes.
 *
 * - Times are Taipei `YYYY-MM-DD HH:mm`; ids use their display form (E001 / S0001 / R001).
 * - Soft-deleted shifts are included; each `payroll_runs` snapshot is flattened into one row per
 *   employee per run. LINE keys, `events`, `messages` and `push_log` are never sent.
 * - Apps Script answers a POST with a 302 to googleusercontent.com; `fetch` follows it (as a GET,
 *   which is what that redirect expects) and the JSON comes back from there.
 * - Each attempt is recorded in `staff_backups` before the POST. The URL and token are never
 *   logged, and network errors are reduced to their name / code.
 */
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import { now as clockNow } from '../db/time.js';
import {
  STAFF_BACKUP_LABELS as L,
  STAFF_BACKUP_SHEETS as SHEETS,
  type StaffBackupFailure,
  staffBackupReason,
} from '../texts.js';
import { displayCorrectionId, displayEmployeeId, displayShiftId } from './ids.js';
import type { PayrollEmployeeLine } from './payroll.js';
import type { StaffRepo } from './repo.js';
import { PAYROLL_SCHEDULE_ACTOR } from './service.js';
import { type LocalDate, taipeiDate, taipeiTime } from './time.js';

/** Apps Script can take a while to write several tabs. */
export const BACKUP_TIMEOUT_MS = 60_000;

export type BackupCell = string | number;

export interface BackupTable {
  name: string;
  header: string[];
  rows: BackupCell[][];
}

export interface BackupPayload {
  token: string;
  force: boolean;
  /** Taipei `YYYY-MM-DD HH:mm`. */
  generatedAt: string;
  tables: BackupTable[];
}

export type BackupPostResult =
  { ok: true; counts: Record<string, number> } | { ok: false; failure: StaffBackupFailure };

/** ISO instant → Taipei `2026-11-12 09:00`; null → empty cell. */
export function backupTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${taipeiDate(d)} ${taipeiTime(d)}`;
}

function label(map: Record<string, string>, code: string | null): string {
  if (code === null) return '';
  return map[code] ?? code;
}

function trigger(triggeredBy: string | null): string {
  if (!triggeredBy) return '';
  return triggeredBy === PAYROLL_SCHEDULE_ACTOR ? L.schedule : triggeredBy;
}

/** Minutes with at most 2 decimals (seconds-level punches give fractional minutes). */
function minutes(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Highest applied migration (「資料庫版本」). */
export function schemaVersion(db: Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/**
 * The seven tabs of §16.2 in sheet order. The last one (`備份資訊`) has one row: when, who,
 * the schema version and the row count of every other tab.
 */
export function buildBackupTables(
  db: Database,
  repo: StaffRepo,
  opts: { now: Date; triggeredBy: string },
  log?: Logger,
): BackupTable[] {
  const employees = repo.employees.listAll();
  const byId = new Map(employees.map((e) => [e.id, e]));
  const eid = (id: number) => displayEmployeeId(id);
  const name = (id: number) => byId.get(id)?.name ?? '';

  const tables: BackupTable[] = [
    {
      ...SHEETS.employees,
      header: [...SHEETS.employees.header],
      rows: employees.map((e) => [
        eid(e.id),
        e.name,
        label(L.employeeStatus, e.status),
        e.user_id,
        backupTime(e.created_at),
        backupTime(e.approved_at),
        e.approved_by ?? '',
      ]),
    },
    {
      ...SHEETS.wages,
      header: [...SHEETS.wages.header],
      rows: repo.wages
        .listAll()
        .map((w) => [
          eid(w.employee_id),
          name(w.employee_id),
          w.hourly_wage,
          w.effective_from,
          w.created_by ?? '',
          backupTime(w.created_at),
        ]),
    },
    {
      ...SHEETS.shifts,
      header: [...SHEETS.shifts.header],
      rows: repo.shifts
        .listAllWithDeleted()
        .map((s) => [
          displayShiftId(s.id),
          eid(s.employee_id),
          name(s.employee_id),
          backupTime(s.start_at),
          backupTime(s.end_at),
          s.end_at ? minutes((Date.parse(s.end_at) - Date.parse(s.start_at)) / 60_000) : '',
          label(L.shiftSource, s.start_source),
          label(L.shiftSource, s.end_source),
          backupTime(s.deleted_at),
          backupTime(s.created_at),
          backupTime(s.updated_at),
        ]),
    },
    {
      ...SHEETS.corrections,
      header: [...SHEETS.corrections.header],
      rows: repo.corrections
        .listAll()
        .map((c) => [
          displayCorrectionId(c.id),
          eid(c.employee_id),
          name(c.employee_id),
          label(L.correctionKind, c.kind),
          backupTime(c.at),
          backupTime(c.end_at),
          label(L.correctionStatus, c.status),
          label(L.correctionReason, c.reason),
          c.requested_by ?? '',
          c.group_id ?? '',
          c.shift_id ? displayShiftId(c.shift_id) : '',
          backupTime(c.created_at),
          c.decided_by ?? '',
          backupTime(c.decided_at),
        ]),
    },
    {
      ...SHEETS.payroll,
      header: [...SHEETS.payroll.header],
      rows: repo.payrollRuns.listAll().flatMap((run) => {
        let lines: Partial<PayrollEmployeeLine>[];
        try {
          const parsed = JSON.parse(run.result_json) as { employees?: unknown };
          lines = Array.isArray(parsed.employees)
            ? (parsed.employees as Partial<PayrollEmployeeLine>[])
            : [];
        } catch {
          log?.warn({ runId: run.id }, 'backup: payroll snapshot is not valid JSON, skipped');
          lines = [];
        }
        return lines.map((e) => [
          run.id,
          run.month,
          backupTime(run.run_at),
          trigger(run.triggered_by),
          e.displayId ?? (e.employeeId ? eid(e.employeeId) : ''),
          e.name ?? '',
          e.shiftCount ?? 0,
          minutes(e.totalMinutes ?? 0),
          e.pay ?? 0,
        ]);
      }),
    },
    {
      ...SHEETS.audit,
      header: [...SHEETS.audit.header],
      rows: repo.audit
        .listAll()
        .map((a) => [
          a.id,
          a.actor,
          a.action,
          a.target ?? '',
          a.before_json ?? '',
          a.after_json ?? '',
          backupTime(a.created_at),
        ]),
    },
  ];

  tables.push({
    name: SHEETS.info.name,
    header: [...SHEETS.info.header, ...tables.map((t) => t.name)],
    rows: [
      [
        backupTime(opts.now.toISOString()),
        trigger(opts.triggeredBy),
        schemaVersion(db),
        ...tables.map((t) => t.rows.length),
      ],
    ],
  });
  return tables;
}

function isTimeout(err: unknown): boolean {
  const n = (err as { name?: string } | null)?.name;
  return n === 'TimeoutError' || n === 'AbortError';
}

/** `{ name, code }` of a fetch error, without its message (which may echo the URL). */
function errInfo(err: unknown): { name?: string; code?: string } {
  const e = err as { name?: string; cause?: { code?: string } } | null;
  return { name: e?.name, code: e?.cause?.code };
}

/** Maps the Apps Script JSON answer (§16.3 / §16.4) to a result. */
export function parseBackupResponse(text: string): BackupPostResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, failure: { code: 'badResponse' } };
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, failure: { code: 'badResponse' } };
  }
  const b = body as { ok?: unknown; counts?: unknown; error?: unknown; table?: unknown };
  if (b.ok === true) {
    const counts: Record<string, number> = {};
    if (typeof b.counts === 'object' && b.counts !== null) {
      for (const [k, v] of Object.entries(b.counts)) {
        if (typeof v === 'number') counts[k] = v;
      }
    }
    return { ok: true, counts };
  }
  if (b.ok !== false) return { ok: false, failure: { code: 'badResponse' } };
  switch (b.error) {
    case 'unauthorized':
      return { ok: false, failure: { code: 'unauthorized' } };
    case 'busy':
      return { ok: false, failure: { code: 'busy' } };
    case 'shrink':
      return {
        ok: false,
        failure: { code: 'shrink', table: typeof b.table === 'string' ? b.table : '' },
      };
    default:
      return {
        ok: false,
        failure: { code: 'script', detail: String(b.error ?? '').slice(0, 80) || '未知' },
      };
  }
}

/** POSTs one backup; never throws. */
export async function postBackup(
  url: string,
  payload: BackupPayload,
  opts: { fetch?: typeof fetch; timeoutMs?: number; log?: Logger } = {},
): Promise<BackupPostResult> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  let text: string;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? BACKUP_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    opts.log?.warn({ err: errInfo(err) }, 'backup request failed');
    return { ok: false, failure: { code: isTimeout(err) ? 'timeout' : 'network' } };
  }
  if (!res.ok) return { ok: false, failure: { code: 'http', status: res.status } };
  return parseBackupResponse(text);
}

export type BackupRunResult =
  | { id: number; ok: true; counts: { name: string; count: number }[] }
  | { id: number; ok: false; failure: StaffBackupFailure };

export interface StaffBackupDeps {
  db: Database;
  repo: StaffRepo;
  url: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Clock for `finished_at`. */
  now?: () => Date;
  log: Logger;
}

export function createStaffBackup(deps: StaffBackupDeps) {
  const { db, repo, log } = deps;
  const clock = deps.now ?? clockNow;
  /** Runs are serialized (schedule and a manual `備份` never overlap). */
  let queue: Promise<unknown> = Promise.resolve();

  async function attempt(opts: {
    /** Taipei date of a scheduled backup; null for a manual one. */
    date: LocalDate | null;
    triggeredBy: string;
    force: boolean;
    now: Date;
  }): Promise<BackupRunResult> {
    const id = repo.backups.start(opts.date, opts.triggeredBy, opts.now);
    let result: BackupPostResult;
    let tables: BackupTable[] | undefined;
    try {
      tables = buildBackupTables(db, repo, opts, log);
      result = await postBackup(
        deps.url,
        {
          token: deps.token,
          force: opts.force,
          generatedAt: backupTime(opts.now.toISOString()),
          tables,
        },
        { fetch: deps.fetch, timeoutMs: deps.timeoutMs, log },
      );
    } catch (err) {
      log.error({ err }, 'backup failed unexpectedly');
      result = { ok: false, failure: { code: 'script', detail: '內部錯誤' } };
    }
    const who = opts.triggeredBy === PAYROLL_SCHEDULE_ACTOR ? 'schedule' : 'admin';
    if (!result.ok) {
      const { failure } = result;
      repo.backups.finish(
        id,
        { ok: false, error: staffBackupReason(failure), counts: null },
        clock(),
      );
      log.warn({ id, date: opts.date, who, failure: failure.code }, 'backup failed');
      return { id, ok: false, failure };
    }
    const sent = result.counts;
    // Data tabs only (備份資訊 always has one row); the sheet's own counts win when present.
    const counts = (tables ?? []).slice(0, -1).map((t) => ({
      name: t.name,
      count: sent[t.name] ?? t.rows.length,
    }));
    const countMap = Object.fromEntries(counts.map((c) => [c.name, c.count]));
    repo.backups.finish(id, { ok: true, error: null, counts: countMap }, clock());
    log.info({ id, date: opts.date, who, counts: countMap, force: opts.force }, 'backup done');
    return { id, ok: true, counts };
  }

  function run(opts: {
    date: LocalDate | null;
    triggeredBy: string;
    force: boolean;
    now: Date;
  }): Promise<BackupRunResult> {
    const next = queue.then(() => attempt(opts));
    queue = next.catch(() => undefined);
    return next;
  }

  return { run };
}

export type StaffBackup = ReturnType<typeof createStaffBackup>;
