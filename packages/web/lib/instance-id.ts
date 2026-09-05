/**
 * One random id per process, generated at first import and never persisted anywhere else. It is
 * written into `schedule_runs.owner_id` so a row in Run History says which process started it,
 * which is what tells two containers apart during a rolling deploy (issue #88). Deliberately not
 * the hostname: two revisions of the same Container App can share one, and a restarted container
 * keeps its hostname while being a different process with no memory of the old one's runs.
 */
export const INSTANCE_ID: string = globalThis.crypto.randomUUID();
