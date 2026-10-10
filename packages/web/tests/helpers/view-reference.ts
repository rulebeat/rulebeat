/**
 * The oracle the view tests hold the routes to: every finding of a tab read in full from the database
 * (rows and all), decorated as the explorer decorates them, and handed to lib/view-response.ts's pure
 * reference. Shared by the parity test and the tests that bring their own fixture.
 *
 * The findings are in fingerprint order. A sort leaves findings that tie in the order they arrived in,
 * and the server answers from the database with no order of its own, so it breaks every tie on the
 * fingerprint: the oracle is fed in that order.
 */
import { listCategories } from '@/lib/db/categories';
import { listReturnedColumns } from '@/lib/db/column-catalogue';
import { listFindings } from '@/lib/db/findings';
import { loadRules } from '@/lib/rules';
import { isActiveSuppression, loadSuppressions } from '@/lib/suppressions';
import { TAB_KINDS, decorateFinding, rulesInPlay, type ViewResponseOptions, type ViewTab } from '@/lib/view-response';

export async function referenceInputs(tab: ViewTab, showSuppressed: boolean) {
  const rules = new Map((await loadRules()).map(r => [r.id, r]));
  const findings = (await listFindings({ kinds: TAB_KINDS[tab] }))
    .map(record => decorateFinding(record, rules.get(record.ruleId)))
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
  const options: ViewResponseOptions = {
    tab,
    catalogueColumns: await listReturnedColumns(rulesInPlay(findings)),
    categories: (await listCategories()).map(c => ({ id: c.id, label: c.label, color: c.color })),
  };
  const suppressedFingerprints = new Set((await loadSuppressions()).filter(isActiveSuppression).map(s => s.fingerprint));
  return { findings, options, ctx: { suppressedFingerprints, showSuppressed } };
}

/** What a response looks like after the wire, so `undefined` fields are gone from both sides. */
export const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
