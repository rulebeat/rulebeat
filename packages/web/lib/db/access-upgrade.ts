/**
 * The Access an upgraded database gives each existing person (#269): the Everything row at their
 * current Role, set by hand, for every non-Admin whose `access_source` is still unset.
 *
 * The unset source is the marker. A person later narrowed to no Scope keeps `manual` and is never
 * granted again, and a row an earlier release adds after a rollback has no source, so the next start
 * picks it up. A stored role that is not a known Role counts as Viewer, as `rowToUser()` does.
 *
 * Pure: SQL out, valid on both backends, so migrate.ts (SQLite) and pg/bootstrap.ts (Postgres) run
 * one plan. The caller runs the statements in order inside one transaction.
 */
export function planAccessUpgrade(): string[] {
  return [
    `INSERT INTO role_assignments (user_id, tenant_id, scope, role)
      SELECT id, '', '/', CASE WHEN role = 'editor' THEN 'editor' ELSE 'viewer' END
      FROM users WHERE role <> 'admin' AND access_source IS NULL
      ON CONFLICT DO NOTHING`,
    `UPDATE users SET access_source = 'manual' WHERE role <> 'admin' AND access_source IS NULL`,
  ];
}
