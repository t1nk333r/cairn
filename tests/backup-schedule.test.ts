import { describe, expect, it } from 'vitest';
import {
  applyBackupSchedule,
  BACKUP_ALARM_NAME,
  runScheduledBackup,
} from '../src/browser/backup-schedule';
import {
  DEFAULT_BACKUP_INTERVAL_MINUTES,
  normalizeBackupSchedule,
} from '../src/browser/backup-schedule-store';
import type { StoredBackupSchedule } from '../src/browser/backup-schedule-store';
import type { BookmarkDocument } from '../src/core/bookmarks';

// Automatic backups are the one feature nobody watches run. Every assertion
// here is about a failure the user would not otherwise notice: an alarm that
// was never registered, an alarm left behind after the schedule was switched
// off, or a backup that threw inside the alarm handler where nothing catches.

const schedule = (over: Partial<StoredBackupSchedule> = {}): StoredBackupSchedule => ({
  enabled: true,
  everyMinutes: 1440,
  target: 'gitea',
  ...over,
});

const document_: BookmarkDocument = {
  schemaVersion: 1,
  generatedAt: '2026-09-03T00:00:00.000Z',
  device: {
    id: 'laptop',
    label: 'Laptop',
    browserFamily: 'chromium',
    browserName: 'Chromium',
  },
  roots: [],
};

interface AlarmCall {
  name: string | undefined;
  info: { delayInMinutes: number; periodInMinutes: number };
}

const recordingAlarms = () => {
  const created: AlarmCall[] = [];
  const cleared: (string | undefined)[] = [];
  return {
    created,
    cleared,
    api: {
      create(name: string | undefined, info: { delayInMinutes: number; periodInMinutes: number }) {
        created.push({ name, info });
      },
      clear(name?: string) {
        cleared.push(name);
        return true;
      },
    },
  };
};

describe('registering the backup alarm', () => {
  it('creates a recurring alarm at the chosen interval', async () => {
    const alarms = recordingAlarms();
    await applyBackupSchedule(alarms.api, schedule({ everyMinutes: 360 }));
    expect(alarms.created).toEqual([
      { name: BACKUP_ALARM_NAME, info: { periodInMinutes: 360, delayInMinutes: 360 } },
    ]);
    expect(alarms.cleared).toEqual([]);
  });

  it('waits a full period before the first run', async () => {
    // Enabling the schedule must not fire a network write while the user is
    // still on the settings screen.
    const alarms = recordingAlarms();
    await applyBackupSchedule(alarms.api, schedule({ everyMinutes: 60 }));
    expect(alarms.created.at(0)?.info.delayInMinutes).toBe(60);
  });

  it('clears the alarm when the schedule is switched off', async () => {
    const alarms = recordingAlarms();
    await applyBackupSchedule(alarms.api, schedule({ enabled: false }));
    expect(alarms.cleared).toEqual([BACKUP_ALARM_NAME]);
    expect(alarms.created).toEqual([]);
  });
});

describe('running a scheduled backup', () => {
  it('captures and writes to the configured backend', async () => {
    const written: string[] = [];
    const record = await runScheduledBackup({
      schedule: schedule({ target: 's3' }),
      capture: async () => document_,
      backUp: async (target, sent) => {
        expect(sent).toBe(document_);
        written.push(target);
      },
      now: () => new Date('2026-09-03T10:00:00.000Z'),
    });
    expect(written).toEqual(['s3']);
    expect(record).toEqual({ at: '2026-09-03T10:00:00.000Z', ok: true });
  });

  it('records a failure instead of throwing', async () => {
    // An unhandled rejection in the alarm handler would leave the user
    // believing backups are running.
    const record = await runScheduledBackup({
      schedule: schedule(),
      capture: async () => {
        throw new Error('Host permission was revoked.');
      },
      backUp: async () => undefined,
    });
    expect(record.ok).toBe(false);
    expect(record.error).toBe('Host permission was revoked.');
    expect(typeof record.at).toBe('string');
  });

  it('writes nothing when the schedule is off', async () => {
    let captured = false;
    const record = await runScheduledBackup({
      schedule: schedule({ enabled: false }),
      capture: async () => {
        captured = true;
        return document_;
      },
      backUp: async () => undefined,
    });
    expect(captured).toBe(false);
    expect(record.ok).toBe(false);
  });
});

describe('normalizing a stored schedule', () => {
  it('falls back to the default interval for an unknown period', () => {
    // A hand-edited or half-written record must not leave the alarm running on
    // a nonsense period.
    expect(normalizeBackupSchedule({ enabled: true, everyMinutes: 7, target: 'gitea' })).toEqual({
      enabled: true,
      everyMinutes: DEFAULT_BACKUP_INTERVAL_MINUTES,
      target: 'gitea',
    });
  });

  it('falls back to a known backend for an unknown target', () => {
    expect(normalizeBackupSchedule({ enabled: true, everyMinutes: 60, target: 'dropbox' }).target)
      .toBe('webdav');
  });

  it('treats anything that is not true as off', () => {
    expect(normalizeBackupSchedule({ enabled: 'yes', everyMinutes: 60, target: 's3' }).enabled)
      .toBe(false);
    expect(normalizeBackupSchedule(null).enabled).toBe(false);
    expect(normalizeBackupSchedule(undefined).enabled).toBe(false);
  });
});
