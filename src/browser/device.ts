import type { BrowserFamily, DeviceObservation } from '../core/inventory';

const DEVICE_ID_KEY = 'deviceId';
const DEVICE_LABEL_KEY = 'deviceLabel';

export function detectBrowserFamily(userAgent: string): BrowserFamily {
  return /firefox/i.test(userAgent) ? 'firefox' : 'chromium';
}

export function detectBrowserName(userAgent: string): string {
  if (/firefox/i.test(userAgent)) return 'Firefox';
  if (/helium/i.test(userAgent)) return 'Helium';
  if (/edg\//i.test(userAgent)) return 'Edge';
  if (/chrome|chromium/i.test(userAgent)) return 'Chromium';
  return 'Chromium-compatible';
}

export async function getDeviceObservation(): Promise<DeviceObservation> {
  const stored = await browser.storage.local.get([DEVICE_ID_KEY, DEVICE_LABEL_KEY]);
  const id =
    typeof stored[DEVICE_ID_KEY] === 'string'
      ? stored[DEVICE_ID_KEY]
      : crypto.randomUUID();
  const label =
    typeof stored[DEVICE_LABEL_KEY] === 'string'
      ? stored[DEVICE_LABEL_KEY]
      : detectBrowserName(navigator.userAgent);

  if (!stored[DEVICE_ID_KEY]) {
    await browser.storage.local.set({
      [DEVICE_ID_KEY]: id,
      [DEVICE_LABEL_KEY]: label,
    });
  }

  return {
    id,
    label,
    browserFamily: detectBrowserFamily(navigator.userAgent),
    browserName: detectBrowserName(navigator.userAgent),
  };
}

