/**
 * Where a finding sits, as the client and the view engine read it. Client-safe: no Node, no database.
 *
 * The stored `subscription_id` of a Directory finding is empty, because the directory is not in a
 * subscription. Wherever a subscription is shown or filtered, though, a Directory finding must be a
 * choice of its own and not a blank, so the view engine's `subscription` field gives it one reserved
 * value (below) that can be filtered, grouped, faceted and deep-linked like a subscription id. A
 * subscription id is a GUID and can never equal it.
 */

export const FINDING_PLACEMENTS = [
  'resource', 'subscription', 'management-group', 'directory', 'workspace', 'unplaceable',
] as const;
export type FindingPlacement = (typeof FINDING_PLACEMENTS)[number];

/** What a Directory finding is called wherever a subscription would be named. */
export const DIRECTORY_LABEL = 'Directory';

/** What each placement is called on screen. Typed over every placement, so a new one without a label fails the type check. */
export const PLACEMENT_LABEL: Record<FindingPlacement, string> = {
  resource: 'Resource',
  subscription: 'Subscription',
  'management-group': 'Management group',
  directory: DIRECTORY_LABEL,
  workspace: 'Workspace',
  unplaceable: 'Not placed',
};

/** What a value of the view engine's `placement` field is called: its label, else the value as stored. */
export function placementValueLabel(value: string): string {
  return (FINDING_PLACEMENTS as readonly string[]).includes(value) ? PLACEMENT_LABEL[value as FindingPlacement] : value;
}

/** What the view engine's `subscription` field holds for a Directory finding. */
export const DIRECTORY_SUBSCRIPTION = 'directory';

interface Placed { placement?: FindingPlacement | string; subscriptionId: string }

/** The value of the `subscription` field for a finding: the reserved Directory value, else its subscription id. */
export function subscriptionValue(f: Placed): string {
  return f.placement === 'directory' ? DIRECTORY_SUBSCRIPTION : f.subscriptionId;
}

/** What names a finding's subscription on screen and in a file: "Directory" for a Directory finding, else the id as stored. */
export function subscriptionText(f: Placed): string {
  return f.placement === 'directory' ? DIRECTORY_LABEL : f.subscriptionId;
}

/** What a value of the `subscription` field is called when nothing better is known: "Directory" for the reserved value, else the id. */
export function subscriptionValueLabel(value: string): string {
  return value === DIRECTORY_SUBSCRIPTION ? DIRECTORY_LABEL : value;
}
