/**
 * An open saved view on Scans (#373, ADR 0012). Every findings read and the export, on each of the three tabs,
 * loads the stored view when the request carries `view=<id>` and adds back the values held back from the reader.
 * The address holds only what the reader can see, so the stored values are never in a request or in a response.
 * A view that no longer opens (deleted, or someone else's Personal view, an Admin's too) is flagged by the read
 * and the export, and the read then follows the address filters alone.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createPeople, MATRIX_OWNER, seedMatrix, share, SUB_ONE, SUB_TWO, type MatrixSeed } from '../helpers/access-matrix';
import { createSavedView, deleteSavedView } from '@/lib/db/saved-views';
import { emptyView, viewToSearchParams, type ViewFilter } from '@/lib/finding-view';
import { OUTSIDE_ACCESS_LABEL } from '@/lib/held-back';
import { VIEW_TABS, type ViewTab } from '@/lib/view-response';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET: VIEW } = await import('@/app/api/findings/view/route');
const { GET: ROWS } = await import('@/app/api/findings/rows/route');
const { GET: GROUP } = await import('@/app/api/findings/group/route');
const { GET: COLUMN_VALUES } = await import('@/app/api/findings/column-values/route');
const { GET: EXPORT } = await import('@/app/api/findings/export/route');

const ONE_SUBSCRIPTION = 'Viewer on one subscription';
const NO_SCOPE = 'No Scope';

let people: Record<string, string>;
let seed: MatrixSeed;
/** Filtered to subscription two, which the Viewer on subscription one does not hold. */
let subscriptionTwoView: string;
/** Filtered to a returned-column value no finding carries. */
let rowView: string;
/** Filtered to a resource only subscription two has. */
let resourceView: string;
/** Subscription one and the Viewer on subscription one's own Personal view. */
let ownPersonalView: string;
let deletedView: string;
let othersPersonalView: string;

async function savedView(name: string, filters: ViewFilter[], visibility: 'shared' | 'personal' = 'shared', owner = MATRIX_OWNER): Promise<string> {
  const made = await createSavedView({ name, tab: 'results', query: viewToSearchParams({ ...emptyView(), filters }).toString() }, owner);
  if (!made.ok) throw new Error(made.reason);
  if (visibility === 'shared') await share('saved_views', made.view.id);
  return made.view.id;
}

beforeAll(async () => {
  await resetDb();
  people = await createPeople();
  seed = await seedMatrix();
  subscriptionTwoView = seed.savedViewId;
  rowView = await savedView('Row view', [{ field: 'row.zone', values: ['nowhere'] }]);
  resourceView = await savedView('Resource view', [{ field: 'resourceName', values: ['vm-other-sub'] }]);
  ownPersonalView = await savedView('Own personal', [{ field: 'subscription', values: [SUB_ONE] }], 'personal', people[ONE_SUBSCRIPTION]);
  deletedView = await savedView('Deleted view', [{ field: 'subscription', values: [SUB_TWO] }]);
  await deleteSavedView(deletedView);
  othersPersonalView = await savedView('Somebody else\'s', [{ field: 'subscription', values: [SUB_TWO] }], 'personal');
});

const signIn = (person: string) => mockAuth.mockResolvedValue({ user: { uid: people[person] } });
const address = (tab: ViewTab, extra: Record<string, string> = {}, view?: string, filters: ViewFilter[] = []) =>
  viewToSearchParams({ ...emptyView(), filters }, { tab, ...(view ? { view } : {}), ...extra }).toString();
const at = (path: string, query: string) => new Request(`http://localhost/api/findings/${path}?${query}`);

/** A finding the Viewer on subscription one can open on each tab. */
const OPENABLE: Record<ViewTab, string> = { results: 'vm-one', advisories: 'advisory-one', activity: 'workspace-user' };

interface ViewBody { total: number; viewMissing?: boolean; outsideAccess: { subscriptions: string[]; resourceGroups: string[] } }
interface GroupBody { total: number; viewMissing?: boolean }
interface ColumnBody { values: { value: string }[]; viewMissing?: boolean }
interface RowsBody { matchedRowCount: number; rowCount: number; viewMissing?: boolean }

async function json<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  return await res.json() as T;
}

describe.each(VIEW_TABS)('on the %s tab, with a saved view open', (tab) => {
  it('view: adds back the subscription held back from the reader, so it matches nothing', async () => {
    signIn(ONE_SUBSCRIPTION);
    const without = await json<ViewBody>(await VIEW(at('view', address(tab))));
    const open = await json<ViewBody>(await VIEW(at('view', address(tab, {}, subscriptionTwoView))));
    expect(without.total).toBeGreaterThan(0);
    expect(open.total).toBe(0);
    expect(open.viewMissing).toBeUndefined();
  });

  it('view: never widens when the address drops or replaces the placeholder', async () => {
    signIn(ONE_SUBSCRIPTION);
    const placeholder: ViewFilter[] = [{ field: 'subscription', values: [OUTSIDE_ACCESS_LABEL] }];
    expect((await json<ViewBody>(await VIEW(at('view', address(tab, {}, subscriptionTwoView, placeholder))))).total).toBe(0);
    // Values can be added next to the marker: the visible one narrows nothing back in.
    const added: ViewFilter[] = [{ field: 'subscription', values: [OUTSIDE_ACCESS_LABEL, SUB_ONE] }];
    const withAdded = await json<ViewBody>(await VIEW(at('view', address(tab, {}, subscriptionTwoView, added))));
    expect(withAdded.total).toBe((await json<ViewBody>(await VIEW(at('view', address(tab, {}, undefined, [{ field: 'subscription', values: [SUB_ONE] }]))))).total);
  });

  it('view: does not send the stored subscription back as an outside-access mark', async () => {
    signIn(ONE_SUBSCRIPTION);
    const res = await VIEW(at('view', address(tab, {}, subscriptionTwoView)));
    expect(JSON.stringify(await res.json())).not.toContain(SUB_TWO);
  });

  it('view: adds back a resource name no finding the reader can see carries', async () => {
    signIn(ONE_SUBSCRIPTION);
    const open = await json<ViewBody>(await VIEW(at('view', address(tab, {}, resourceView))));
    expect(open.total).toBe(0);
  });

  it('view: leaves the Admin, who holds Everything, with the address alone', async () => {
    signIn('Admin');
    const everything = await json<ViewBody>(await VIEW(at('view', address(tab))));
    const open = await json<ViewBody>(await VIEW(at('view', address(tab, {}, subscriptionTwoView))));
    expect(open.total).toBe(everything.total);
  });

  it('group: adds back the held-back subscription', async () => {
    signIn(ONE_SUBSCRIPTION);
    const query = (view?: string) => `${address(tab, {}, view)}&group=category&groupPath=%5B%22security%22%5D`;
    const without = await json<GroupBody>(await GROUP(at('group', query())));
    const open = await json<GroupBody>(await GROUP(at('group', query(subscriptionTwoView))));
    expect(without.total).toBeGreaterThan(0);
    expect(open.total).toBe(0);
  });

  it('column-values: adds back the held-back subscription', async () => {
    signIn(ONE_SUBSCRIPTION);
    const without = await json<ColumnBody>(await COLUMN_VALUES(at('column-values', `${address(tab)}&column=row.zone`)));
    const open = await json<ColumnBody>(await COLUMN_VALUES(at('column-values', `${address(tab, {}, subscriptionTwoView)}&column=row.zone`)));
    expect(without.values.length).toBeGreaterThan(0);
    expect(open.values).toEqual([]);
  });

  it('rows: adds back a returned-column value held back from the reader', async () => {
    signIn(ONE_SUBSCRIPTION);
    const fingerprint = seed.fingerprints[OPENABLE[tab]]!;
    const without = await json<RowsBody>(await ROWS(at('rows', `${address(tab)}&fingerprint=${fingerprint}`)));
    const open = await json<RowsBody>(await ROWS(at('rows', `${address(tab, {}, rowView)}&fingerprint=${fingerprint}`)));
    expect(without.matchedRowCount).toBeGreaterThan(0);
    expect(open.matchedRowCount).toBe(0);
    expect(open.rowCount).toBe(without.rowCount);
  });

  it('export: adds back the held-back subscription', async () => {
    signIn(ONE_SUBSCRIPTION);
    const without = await (await EXPORT(at('export', `${address(tab)}&format=json`))).json() as unknown[];
    const res = await EXPORT(at('export', `${address(tab, {}, subscriptionTwoView)}&format=json`));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-View-Missing')).toBeNull();
    expect(without.length).toBeGreaterThan(0);
    expect(await res.json()).toEqual([]);
  });

  it('a person who holds no Scope still reads nothing with a view open', async () => {
    signIn(NO_SCOPE);
    expect((await json<ViewBody>(await VIEW(at('view', address(tab, {}, subscriptionTwoView))))).total).toBe(0);
  });
});

describe.each(VIEW_TABS)('on the %s tab, with a view that does not open', (tab) => {
  const gone: [string, () => string][] = [
    ['deleted', () => deletedView],
    ['somebody else\'s Personal view', () => othersPersonalView],
    ['an id that was never a view', () => 'no-such-view'],
  ];

  it.each(gone)('flags %s on every read and follows the address filters', async (_name, id) => {
    signIn(ONE_SUBSCRIPTION);
    const filters: ViewFilter[] = [{ field: 'subscription', values: [SUB_ONE] }];
    const query = address(tab, {}, id(), filters);
    const plain = await json<ViewBody>(await VIEW(at('view', address(tab, {}, undefined, filters))));

    const view = await json<ViewBody>(await VIEW(at('view', query)));
    expect(view.viewMissing).toBe(true);
    expect(view.total).toBe(plain.total);
    expect(plain.viewMissing).toBeUndefined();

    const group = await json<GroupBody>(await GROUP(at('group', `${query}&group=category&groupPath=%5B%22security%22%5D`)));
    expect(group.viewMissing).toBe(true);
    const column = await json<ColumnBody>(await COLUMN_VALUES(at('column-values', `${query}&column=row.zone`)));
    expect(column.viewMissing).toBe(true);
    const rows = await json<RowsBody>(await ROWS(at('rows', `${query}&fingerprint=${seed.fingerprints[OPENABLE[tab]]}`)));
    expect(rows.viewMissing).toBe(true);
  });

  it.each(gone)('flags %s on the export, which still carries the address filters', async (_name, id) => {
    signIn(ONE_SUBSCRIPTION);
    const res = await EXPORT(at('export', `${address(tab, {}, id())}&format=json`));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-View-Missing')).toBe('1');
    expect((await res.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it('answers an Admin the same for somebody else\'s Personal view as for a deleted one', async () => {
    signIn('Admin');
    const others = await json<ViewBody>(await VIEW(at('view', address(tab, {}, othersPersonalView))));
    const deleted = await json<ViewBody>(await VIEW(at('view', address(tab, {}, deletedView))));
    expect(others.viewMissing).toBe(true);
    expect(deleted).toEqual(others);
  });

  it('opens the reader\'s own Personal view', async () => {
    signIn(ONE_SUBSCRIPTION);
    const view = await json<ViewBody>(await VIEW(at('view', address(tab, {}, ownPersonalView))));
    expect(view.viewMissing).toBeUndefined();
  });
});
