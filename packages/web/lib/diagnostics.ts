import { getSchedulerStatus } from './scheduler';
import { getSchemaCacheStatus, type SchemaCacheStatus } from './schema-cache';
import { getAppVersion } from './version';

export interface SystemDiagnostics {
  version: string;
  scheduler: ReturnType<typeof getSchedulerStatus>;
  schemaCache: SchemaCacheStatus;
  checkedAt: string;
}

export async function getSystemDiagnostics(): Promise<SystemDiagnostics> {
  return {
    version: getAppVersion(),
    scheduler: getSchedulerStatus(),
    schemaCache: await getSchemaCacheStatus(),
    checkedAt: new Date().toISOString(),
  };
}
