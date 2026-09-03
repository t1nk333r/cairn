const SCHEDULE_KEY = 'bookmarkBackupSchedule';
const INCLUDED_ROOTS_KEY = 'bookmarkIncludedRootIds';

export type BackupTarget = 'webdav' | 's3' | 'gitea' | 'github';

/** Minutes between automatic backups. The alarms API refuses periods below 1. */
export const BACKUP_INTERVALS = [
  { minutes: 60, label: 'Every hour' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 1440, label: 'Every day' },
  { minutes: 10080, label: 'Every week' },
] as const;

export const DEFAULT_BACKUP_INTERVAL_MINUTES = 1440;

export interface StoredBackupSchedule {
  enabled: boolean;
  everyMinutes: number;
  target: BackupTarget;
}

export interface BackupRunRecord {
  /** ISO 8601 of the attempt, successful or not. */
  at: string;
  ok: boolean;
  /** Present only on failure, for display in the control center. */
  error?: string;
}

const LAST_RUN_KEY = 'bookmarkBackupLastRun';

const TARGETS: Record<string, true> = { webdav: true, s3: true, gitea: true, github: true };

export const DEFAULT_BACKUP_SCHEDULE: StoredBackupSchedule = {
  enabled: false,
  everyMinutes: DEFAULT_BACKUP_INTERVAL_MINUTES,
  target: 'webdav',
};

/**
 * Normalizes whatever is in storage into a usable schedule.
 *
 * A half-written or hand-edited record must not leave the alarm registered
 * with a nonsense period: an unrecognised interval or target falls back to the
 * default rather than disabling the schedule silently, because a user who
 * asked for automatic backups should not discover months later that none ran.
 */
export function normalizeBackupSchedule(value: unknown): StoredBackupSchedule {
  if (!value || typeof value !== 'object') return DEFAULT_BACKUP_SCHEDULE;
  const record = value as Partial<StoredBackupSchedule>;
  const known = BACKUP_INTERVALS.some((interval) => interval.minutes === record.everyMinutes);
  return {
    enabled: record.enabled === true,
    everyMinutes: known
      ? (record.everyMinutes as number)
      : DEFAULT_BACKUP_INTERVAL_MINUTES,
    target:
      typeof record.target === 'string' && TARGETS[record.target]
        ? (record.target as BackupTarget)
        : DEFAULT_BACKUP_SCHEDULE.target,
  };
}

export async function saveBackupSchedule(schedule: StoredBackupSchedule): Promise<void> {
  await browser.storage.local.set({ [SCHEDULE_KEY]: normalizeBackupSchedule(schedule) });
}

export async function loadBackupSchedule(): Promise<StoredBackupSchedule> {
  const stored = await browser.storage.local.get(SCHEDULE_KEY);
  return normalizeBackupSchedule(stored[SCHEDULE_KEY]);
}

export async function saveBackupRun(record: BackupRunRecord): Promise<void> {
  await browser.storage.local.set({ [LAST_RUN_KEY]: record });
}

export async function loadBackupRun(): Promise<BackupRunRecord | null> {
  const stored = await browser.storage.local.get(LAST_RUN_KEY);
  const record = stored[LAST_RUN_KEY] as Partial<BackupRunRecord> | undefined;
  if (!record || typeof record.at !== 'string' || typeof record.ok !== 'boolean') return null;
  return {
    at: record.at,
    ok: record.ok,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  };
}

/**
 * Live root ids to include in a backup. An empty list means every root, which
 * is also the state a fresh install is in — the selection is an opt-in filter,
 * never a way to end up backing up nothing by default.
 */
export async function saveIncludedRootIds(ids: readonly string[]): Promise<void> {
  await browser.storage.local.set({ [INCLUDED_ROOTS_KEY]: [...new Set(ids)] });
}

export async function loadIncludedRootIds(): Promise<string[]> {
  const stored = await browser.storage.local.get(INCLUDED_ROOTS_KEY);
  const ids = stored[INCLUDED_ROOTS_KEY];
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}
