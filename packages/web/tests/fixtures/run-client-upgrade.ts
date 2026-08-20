/**
 * Runs the product's real startup path against one sample database, in a throwaway process.
 *
 * `lib/db/client.ts` opens its connection and applies every migration and seed as a side effect of
 * being imported, keyed off `RULEBEAT_DB_PATH` and `process.cwd()`. So the only faithful way to drive
 * it is to set those and import it — which can only be done once per process, hence a fresh one per
 * sample database.
 *
 * `DATA_DIR` is `process.cwd() + '/data'` and is deliberately not overridable, so the caller spawns
 * this with its cwd set to the sample's own directory. That keeps seeding away from the developer's
 * real `data/` folder, which holds untracked scan and schema files locally and nothing on CI.
 */
import '../../lib/db/client';
