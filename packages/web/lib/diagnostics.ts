import { describeBackend, formatBackend, type DatabaseBackendInfo } from './db/backend';
import { sqliteFilePath } from './db/client';
import { getSchedulerStatus } from './scheduler';
import { getSchemaCacheStatus, type SchemaCacheStatus } from './schema-cache';
import { getAppVersion } from './version';

/**
 * Which database this process is on, for the Diagnostics page. Exists because a deployment can
 * run on the wrong backend without any symptom until a restart empties it: a Container Apps
 * install whose connection string never reached the running revision booted SQLite inside the
 * container and worked until the first restart. `summary` is the same sentence the boot log
 * prints; the structured fields are for anyone comparing two deployments. Never the password.
 */
export interface StorageDiagnostics extends DatabaseBackendInfo {
  /** SQLite only: the database file this process opened. */
  file: string | null;
  summary: string;
}

export interface SystemDiagnostics {
  version: string;
  storage: StorageDiagnostics;
  scheduler: ReturnType<typeof getSchedulerStatus>;
  schemaCache: SchemaCacheStatus;
  checkedAt: string;
}

export function getStorageDiagnostics(): StorageDiagnostics {
  const info = describeBackend();
  const file = info.kind === 'sqlite' ? sqliteFilePath : null;
  return { ...info, file, summary: formatBackend(info, file) };
}

export async function getSystemDiagnostics(): Promise<SystemDiagnostics> {
  return {
    version: getAppVersion(),
    storage: getStorageDiagnostics(),
    scheduler: getSchedulerStatus(),
    schemaCache: await getSchemaCacheStatus(),
    checkedAt: new Date().toISOString(),
  };
}
