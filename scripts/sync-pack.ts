#!/usr/bin/env tsx
/**
 * RuleBeat pack sync script.
 * Fetches external policy packs at a pinned version, transforms them to RuleBeat
 * Policy format, and writes the output to packages/web/data/packs/{pack-id}.json.
 *
 * Usage:
 *   npx tsx scripts/sync-pack.ts <pack-id> --commit=<sha-or-tag>
 *
 * Examples:
 *   npx tsx scripts/sync-pack.ts aprl-v2 --commit=abc123def
 *   npx tsx scripts/sync-pack.ts aprl-v2 --commit=main
 *
 * The output file is committed to the repo. Self-hosters receive pack updates
 * as part of normal RuleBeat version upgrades — they never run this script.
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Policy } from '../packages/web/lib/types';

// ---- Types ----

export interface PackDefinition {
  id: string;
  label: string;
  source: string;
  license: string;
  attribution: string;
  fetch(commit: string): Promise<Policy[]>;
}

// ---- Pack registry ----

const PACKS: Record<string, () => Promise<PackDefinition>> = {
  'aprl-v2': () => import('./packs/aprl-v2').then(m => m.aprlV2Pack),
};

// ---- Manifest helpers ----

const PACKS_DIR = join(__dirname, '../packages/web/data/packs');
const MANIFEST_PATH = join(PACKS_DIR, 'pack-manifest.json');

function loadManifest(): Record<string, unknown> {
  if (!existsSync(MANIFEST_PATH)) return {};
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

function saveManifest(manifest: Record<string, unknown>): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

// ---- Commit date ----

/**
 * The commit's full sha and committer timestamp (UTC, whole seconds). It is the pack's
 * version: two commits sort by it, and an admin sees it as a date. Read from GitHub rather than
 * typed in, so the manifest cannot carry a date that belongs to a different commit.
 */
async function fetchCommit(source: string, commit: string): Promise<{ sha: string; date: string }> {
  const repo = new URL(source).pathname.replace(/^\/|\/$/g, '');
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(commit)}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`could not read the commit date for ${commit} (${res.status})`);
  const body = await res.json() as { sha: string; commit: { committer: { date: string } } };
  return { sha: body.sha, date: body.commit.committer.date };
}

// ---- Validation ----

function validatePolicies(policies: Policy[]): { valid: Policy[]; errors: string[] } {
  const errors: string[] = [];
  const valid: Policy[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const p of policies) {
    if (!p.id)          { errors.push(`Missing id on policy: ${p.name}`); continue; }
    if (!p.name)        { errors.push(`Missing name on policy: ${p.id}`); continue; }
    if (!p.category)    { errors.push(`Missing category on policy: ${p.id}`); continue; }
    if (!p.severity)    { errors.push(`Missing severity on policy: ${p.id}`); continue; }
    if (!p.rawKql)      { errors.push(`No rawKql on policy: ${p.id} — skipping`); continue; }
    if (seenIds.has(p.id)) { errors.push(`Duplicate id: ${p.id}`); continue; }
    if (seenNames.has(p.name.toLowerCase())) {
      errors.push(`Duplicate name: "${p.name}" — appending guid suffix`);
      // Make name unique by appending id suffix
      p.name = `${p.name} (${p.id.split('-').pop()})`;
    }
    seenIds.add(p.id);
    seenNames.add(p.name.toLowerCase());
    valid.push(p);
  }
  return { valid, errors };
}

// ---- CLI ----

async function main() {
  const args = process.argv.slice(2);
  const packId = args[0];
  const commitArg = args.find(a => a.startsWith('--commit='));
  const commit = commitArg ? commitArg.split('=')[1] : 'main';

  if (!packId) {
    console.error('Usage: npx tsx scripts/sync-pack.ts <pack-id> --commit=<sha>\n');
    console.error('Available packs:', Object.keys(PACKS).join(', '));
    process.exit(1);
  }

  if (!PACKS[packId]) {
    console.error(`Unknown pack: "${packId}". Available: ${Object.keys(PACKS).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n📦 Syncing pack: ${packId} @ ${commit}\n`);

  const pack = await PACKS[packId]();
  const policies = await pack.fetch(commit);

  console.log(`\n  Validating ${policies.length} policies...`);
  const { valid, errors } = validatePolicies(policies);

  if (errors.length > 0) {
    console.warn(`\n  ⚠  ${errors.length} validation issue(s):`);
    errors.forEach(e => console.warn(`     - ${e}`));
  }

  const outPath = join(PACKS_DIR, `${packId}.json`);
  writeFileSync(outPath, JSON.stringify(valid, null, 2) + '\n', 'utf-8');
  console.log(`\n  ✓ Written ${valid.length} policies to ${outPath}`);

  // Update manifest. `versionScheme` is chosen per pack by a maintainer and survives a sync; the
  // version itself is the commit's timestamp, which is what an admin compares against.
  const manifest = loadManifest();
  const previous = manifest[packId] as { versionScheme?: string } | undefined;
  const pinned = await fetchCommit(pack.source, commit);
  manifest[packId] = {
    label: pack.label,
    source: pack.source,
    license: pack.license,
    attribution: pack.attribution,
    versionScheme: previous?.versionScheme ?? 'upstream-commit-date',
    pinnedCommit: pinned.sha,
    pinnedCommitDate: pinned.date,
    syncedAt: new Date().toISOString().slice(0, 10),
    policyCount: valid.length,
  };
  saveManifest(manifest);
  console.log(`  ✓ Updated pack-manifest.json\n`);

  console.log(`  Commit these files to ship the updated pack:\n`);
  console.log(`    packages/web/data/packs/${packId}.json`);
  console.log(`    packages/web/data/packs/pack-manifest.json\n`);
}

main().catch(err => {
  console.error('\n❌ Sync failed:', err);
  process.exit(1);
});
