// Seeds the isolated, temp-path SQLite database the Playwright admin-fixture server points at
// (RULEBEAT_DB_PATH set by the caller before this process starts). Deliberately no static imports
// of anything under lib/ — same reasoning as scripts/generate-demo.ts: RULEBEAT_DB_PATH,
// RULEBEAT_INITIAL_ADMIN and RULEBEAT_INITIAL_PASSWORD must already be set in the environment
// before lib/db/client.ts's module-load-time DB_PATH resolution ever runs, and importing it here
// would be hoisted above any assignment this file made itself.
//
// Run only by tests/e2e/global-setup.ts, via `npx tsx scripts/seed-e2e.ts`, never by the product.

async function main(): Promise<void> {
  const viewerEmail = process.env.RULEBEAT_E2E_VIEWER_EMAIL;
  const viewerPassword = process.env.RULEBEAT_E2E_VIEWER_PASSWORD;
  if (!viewerEmail || !viewerPassword) {
    throw new Error('RULEBEAT_E2E_VIEWER_EMAIL / RULEBEAT_E2E_VIEWER_PASSWORD must be set');
  }

  // Importing lib/db/client triggers runMigrations + runSeeds (built-ins, categories, and the
  // local owner account from RULEBEAT_INITIAL_ADMIN/RULEBEAT_INITIAL_PASSWORD) as a side effect.
  const { createUser, getUserByEmail } = await import('../lib/db/users');
  const { setPassword } = await import('../lib/db/local-accounts');
  const { hashPasswordSync } = await import('../lib/password');
  const { loadRules } = await import('../lib/rules');
  const { syncScanFindings } = await import('../lib/db/findings');
  const { createFinding } = await import('@rulebeat/core/finding');
  const { setOnboardingState } = await import('../lib/onboarding');

  // A genuinely fresh install (zero users before seedOwnerAccount() ran, exactly the case here)
  // seeds onboarding as 'pending' and (app)/layout.tsx redirects every admin into the /onboarding
  // wizard. That wizard is its own untested surface, not this suite's concern — skip it so the
  // rest of the suite can sign in straight to a dashboard, the same as any already-onboarded install.
  setOnboardingState({ status: 'skipped' });

  const viewerResult = createUser({ email: viewerEmail, role: 'viewer' });
  if ('error' in viewerResult) throw new Error(`seed-e2e: could not create viewer user: ${viewerResult.error}`);
  setPassword(viewerResult.user.id, hashPasswordSync(viewerPassword), { mustChangePassword: false });

  // seedOwnerAccount() (lib/db/migrate.ts) always forces a password change on first sign-in — real
  // and correct product behavior, already covered end-to-end by the Docker smoke test. Re-setting
  // it here so the rest of this suite can sign in as admin directly, since re-testing that specific
  // gate again isn't this suite's job.
  const adminEmail = process.env.RULEBEAT_INITIAL_ADMIN;
  const adminPassword = process.env.RULEBEAT_INITIAL_PASSWORD;
  if (adminEmail && adminPassword) {
    const admin = getUserByEmail(adminEmail.trim().toLowerCase());
    if (admin) setPassword(admin.id, hashPasswordSync(adminPassword), { mustChangePassword: false });
  }

  const rules = loadRules();
  const seedRule = rules.find(r => r.enabled) ?? rules[0];
  if (!seedRule) throw new Error('seed-e2e: no rules available to seed a finding against — built-ins did not seed');

  const finding = createFinding({
    module: seedRule.category,
    ruleId: seedRule.id,
    severity: 'high',
    category: seedRule.category,
    resourceId: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/e2e-rg/providers/Microsoft.Storage/storageAccounts/e2estorage',
    resourceType: 'microsoft.storage/storageaccounts',
    resourceName: 'e2estorage',
    subscriptionId: '00000000-0000-0000-0000-000000000000',
    resourceGroup: 'e2e-rg',
    title: 'E2E seeded finding',
    description: 'Synthetic finding seeded for the Playwright suite, not a real scan result.',
    evidence: {},
    recommendation: 'No action needed — this is test fixture data.',
  });

  syncScanFindings({
    scanId: 'e2e-seed-scan',
    category: seedRule.category,
    ranRuleIds: [seedRule.id],
    // createFinding() (core) returns detectedAt as a Date; syncScanFindings (web) never reads this
    // field from the input (it derives detectedAt from the DB's own firstSeenAt), it just needs the
    // shape to match web's Finding type, which stores it as an ISO string.
    findings: [{ ...finding, detectedAt: finding.detectedAt.toISOString() }],
    finishedAt: new Date().toISOString(),
  });

  console.log(`[seed-e2e] seeded viewer ${viewerEmail} and one finding for rule ${seedRule.id}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
