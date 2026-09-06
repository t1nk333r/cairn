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

// Own-property lookup only: a plain `TARGETS[value]` would accept
// 'constructor' and every other inherited key as a valid backend.
const TARGETS: Record<string, true> = { webdav: true, s3: true, gitea: true, github: true };

export const DEFAULT_BACKUP_SCHEDULE: StoredBackupSchedule = {
  enabled: false,
  everyMinutes: DEFAULT_BACKUP_INTERVAL_MINUTES,
  target: 'webdav',
};

/**
 * Normalizes whatever is in storage into a usable schedule.
 *
 * An unrecognised interval is safe to default: the user asked for automatic
 * backups and should not discover months later that none ran. An unrecognised
 * target is not safe to default — writing the bookmark tree to a backend the
 * user never chose is a disclosure, not an inconvenience — so a corrupt or
 * hand-edited target switches the schedule off instead of retargeting it.
 */
export function normalizeBackupSchedule(value: unknown): StoredBackupSchedule {
  if (!value || typeof value !== 'object') return DEFAULT_BACKUP_SCHEDULE;
  const record = value as Partial<StoredBackupSchedule>;
  const known = BACKUP_INTERVALS.some((interval) => interval.minutes === record.everyMinutes);
  const target =
    typeof record.target === 'string' && Object.hasOwn(TARGETS, record.target)
      ? (record.target as BackupTarget)
      : null;
  return {
    enabled: record.enabled === true && target !== null,
    everyMinutes: known
      ? (record.everyMinutes as number)
      : DEFAULT_BACKUP_INTERVAL_MINUTES,
    target: target ?? DEFAULT_BACKUP_SCHEDULE.target,
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

/**
 * Refuses to guess when the stored selection is unreadable.
 *
 * "Empty means every root" is only correct when the user never set a filter.
 * Quietly dropping malformed entries would turn a corrupted selection into an
 * unfiltered backup, which uploads exactly the folders the filter existed to
 * withhold. Failing here surfaces as a visible backup error instead.
 */
export async function loadIncludedRootIds(): Promise<string[]> {
  const stored = await browser.storage.local.get(INCLUDED_ROOTS_KEY);
  const ids = stored[INCLUDED_ROOTS_KEY];
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new Error(
      'The bookmark folder selection is unreadable, so Cairn will not guess what to back up. Re-pick the folders in the control center.',
    );
  }
  return ids as string[];
}
