/**
 * Fixed subscription identities shared between the demo API surface (this file, read by
 * `/api/azure/subscriptions`) and the future synthetic data generator
 * (`scripts/generate-demo.ts`, WS2c) — both must agree on the same ids and names, or a demo
 * visitor's subscription picker and the scan data behind it disagree.
 *
 * IDs are fixed placeholder GUIDs, not randomly generated: the same demo looks the same every
 * time it's built, which is also what makes `demo-generator.test.ts` able to assert on it.
 * Names matter, not just ids — the subscription scorecard widget falls back to the raw GUID when
 * a subscription has no display name, and that's the worst possible look for a demo.
 */
export interface DemoSubscription {
  id: string;
  name: string;
}

export const DEMO_SUBSCRIPTIONS: DemoSubscription[] = [
  { id: '00000000-0000-0000-0000-000000000001', name: 'Contoso Platform (Prod)' },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Contoso Platform (Dev)' },
  { id: '00000000-0000-0000-0000-000000000003', name: 'Contoso Data & Analytics' },
  { id: '00000000-0000-0000-0000-000000000004', name: 'Contoso Shared Services' },
];
