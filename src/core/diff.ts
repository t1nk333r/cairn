import type { ExtensionInventoryItem, InventoryDocument } from './inventory';

export interface VersionChange {
  id: string;
  name: string;
  localVersion: string;
  remoteVersion: string;
}

export interface StateChange {
  id: string;
  name: string;
  localEnabled: boolean;
  remoteEnabled: boolean;
}

export interface InventoryDiff {
  onlyLocal: ExtensionInventoryItem[];
  onlyRemote: ExtensionInventoryItem[];
  versionChanges: VersionChange[];
  stateChanges: StateChange[];
}

const keyOf = (item: ExtensionInventoryItem) =>
  `${item.browserFamily}:${item.id}`;

export function diffInventories(
  local: InventoryDocument,
  remote: InventoryDocument,
): InventoryDiff {
  const localByKey = new Map(local.extensions.map((item) => [keyOf(item), item]));
  const remoteByKey = new Map(remote.extensions.map((item) => [keyOf(item), item]));
  const onlyLocal: ExtensionInventoryItem[] = [];
  const onlyRemote: ExtensionInventoryItem[] = [];
  const versionChanges: VersionChange[] = [];
  const stateChanges: StateChange[] = [];

  for (const [key, item] of localByKey) {
    const other = remoteByKey.get(key);
    if (!other) {
      onlyLocal.push(item);
      continue;
    }
    if (item.version !== other.version) {
      versionChanges.push({
        id: item.id,
        name: item.name,
        localVersion: item.version,
        remoteVersion: other.version,
      });
    }
    if (item.enabled !== other.enabled) {
      stateChanges.push({
        id: item.id,
        name: item.name,
        localEnabled: item.enabled,
        remoteEnabled: other.enabled,
      });
    }
  }

  for (const [key, item] of remoteByKey) {
    if (!localByKey.has(key)) onlyRemote.push(item);
  }

  const byName = <T extends { name: string }>(left: T, right: T) =>
    left.name.localeCompare(right.name);
  return {
    onlyLocal: onlyLocal.sort(byName),
    onlyRemote: onlyRemote.sort(byName),
    versionChanges: versionChanges.sort(byName),
    stateChanges: stateChanges.sort(byName),
  };
}

