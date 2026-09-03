import type { BookmarkDocument } from '../core/bookmarks';
import type { BackupRunRecord, BackupTarget, StoredBackupSchedule } from './backup-schedule-store';

/**
 * Automatic bookmark backups run on `browser.alarms`, not `setInterval`.
 *
 * An MV3 service worker is killed after roughly 30 seconds idle, so a timer
 * created in the worker dies with it and the backup silently stops happening.
 * Alarms are held by the browser and wake the worker to deliver them, which is
 * the only mechanism that survives that teardown.
 */
export const BACKUP_ALARM_NAME = 'cairn:bookmark-backup';

/**
 * The subset of `browser.alarms` this module uses, injectable for tests.
 *
 * Both fields are required rather than optional: the extension typings declare
 * `AlarmCreateInfo` as a union that demands either `when` or `delayInMinutes`,
 * so an all-optional object matches no branch of it. This module always sets
 * both anyway.
 */
export interface AlarmsApi {
  create(
    name: string | undefined,
    info: { delayInMinutes: number; periodInMinutes: number },
  ): unknown;
  clear(name?: string): unknown;
}

/**
 * Registers or removes the recurring alarm to match the stored schedule.
 *
 * Safe to call repeatedly: creating an alarm with an existing name replaces it.
 * That matters because this runs on install, on browser startup, and on every
 * settings save — an extension update clears alarms, so re-registering on
 * startup is what keeps a schedule alive across upgrades.
 */
export async function applyBackupSchedule(
  alarms: AlarmsApi,
  schedule: StoredBackupSchedule,
): Promise<void> {
  if (!schedule.enabled) {
    await alarms.clear(BACKUP_ALARM_NAME);
    return;
  }
  // A first run one full period out, not immediately: enabling the schedule
  // should not fire a network write while the user is still on the settings
  // screen deciding.
  await alarms.create(BACKUP_ALARM_NAME, {
    periodInMinutes: schedule.everyMinutes,
    delayInMinutes: schedule.everyMinutes,
  });
}

export interface ScheduledBackupInput {
  schedule: StoredBackupSchedule;
  /** Captures the current tree, already filtered to the selected roots. */
  capture: () => Promise<BookmarkDocument>;
  backUp: (target: BackupTarget, document: BookmarkDocument) => Promise<unknown>;
  now?: () => Date;
}

/**
 * Runs one scheduled backup and reports what happened.
 *
 * Failures are recorded rather than thrown: the alarm handler has nobody to
 * report to, and an unhandled rejection there would leave the user believing
 * backups are running. A revoked host permission or an expired token shows up
 * in the control center instead.
 */
export async function runScheduledBackup(
  input: ScheduledBackupInput,
): Promise<BackupRunRecord> {
  const at = (input.now?.() ?? new Date()).toISOString();
  if (!input.schedule.enabled) {
    return { at, ok: false, error: 'The automatic backup schedule is switched off.' };
  }
  try {
    const document = await input.capture();
    await input.backUp(input.schedule.target, document);
    return { at, ok: true };
  } catch (cause) {
    return {
      at,
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
