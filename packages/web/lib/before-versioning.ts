/**
 * The version recorded for a definition that was stored before versions existed and differs from
 * what ships. Its own module because both the seeding plan (`rule-versions.ts`, which reads the
 * catalogue and the file system) and the client-safe Library helpers (`rule-version-markers.ts`)
 * need the name, and the second must not import the first.
 */
export const BEFORE_VERSIONING = 'before-versioning';
