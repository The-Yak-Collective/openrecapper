import fs from 'fs';
import path from 'path';
import { Config } from '../config';

/** A per-guild allow-list entry granting a non-admin user access to /record. */
export interface RecordPermissionGrant {
  guildId: string;
  userId: string;
  grantedBy: string;
  grantedAt: string;
}

interface RecordPermissionFile {
  grants: RecordPermissionGrant[];
}

let grants: RecordPermissionGrant[] | null = null;
let storeLocked = false;

export function getRecordPermissionsPath(): string {
  return (
    Config.RECORD_PERMISSIONS_FILE ||
    path.join(__dirname, '..', '..', 'data', 'record-permissions.json')
  );
}

export function loadRecordPermissions(): RecordPermissionGrant[] {
  const filePath = getRecordPermissionsPath();
  if (!fs.existsSync(filePath)) {
    grants = [];
    return grants;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as RecordPermissionFile;
    grants = Array.isArray(parsed.grants) ? parsed.grants : [];
  } catch (err) {
    console.error('[RecordPermissionStore] Failed to read permissions file, treating as empty:', err);
    grants = [];
  }
  return grants;
}

export function getRecordPermissionGrants(): RecordPermissionGrant[] {
  if (grants === null) loadRecordPermissions();
  return grants!;
}

export function getRecordPermissionGrantsForGuild(guildId: string): RecordPermissionGrant[] {
  return getRecordPermissionGrants().filter((g) => g.guildId === guildId);
}

export function hasRecordPermission(guildId: string, userId: string): boolean {
  return getRecordPermissionGrants().some((g) => g.guildId === guildId && g.userId === userId);
}

function withStoreLock<T>(fn: () => T): T {
  if (storeLocked) {
    throw new Error('Record permission store is already mutating; retry the command in a moment');
  }
  storeLocked = true;
  try {
    return fn();
  } finally {
    storeLocked = false;
  }
}

function persist(): void {
  const filePath = getRecordPermissionsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body: RecordPermissionFile = { grants: getRecordPermissionGrants() };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/** Grant /record access to a user in a guild. Returns the existing grant if already present. */
export function grantRecordPermission(
  guildId: string,
  userId: string,
  grantedBy: string,
): { grant: RecordPermissionGrant; created: boolean } {
  return withStoreLock(() => {
    const existing = getRecordPermissionGrants().find(
      (g) => g.guildId === guildId && g.userId === userId,
    );
    if (existing) return { grant: existing, created: false };

    const grant: RecordPermissionGrant = {
      guildId,
      userId,
      grantedBy,
      grantedAt: new Date().toISOString(),
    };
    getRecordPermissionGrants().push(grant);
    persist();
    return { grant, created: true };
  });
}

/** Revoke /record access from a user in a guild. Returns true if a grant was removed. */
export function revokeRecordPermission(guildId: string, userId: string): boolean {
  return withStoreLock(() => {
    const list = getRecordPermissionGrants();
    const idx = list.findIndex((g) => g.guildId === guildId && g.userId === userId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    persist();
    return true;
  });
}
