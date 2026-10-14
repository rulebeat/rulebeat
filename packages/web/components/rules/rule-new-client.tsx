'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RuleForm } from '@/components/rules/rule-form';
import { ChecksPickerDialog } from '@/components/rules/checks-picker-dialog';
import type { Category, QueryBackend, Rule } from '@/lib/types';

// Written by the live Query page's "Save as rule" action, read once here and cleared immediately.
// A page refresh after landing on /rules/new must not re-trigger the prefill.
const QUERY_PREFILL_KEY = 'rulebeat:query-prefill';

function readQueryPrefill(): Rule | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = sessionStorage.getItem(QUERY_PREFILL_KEY);
  if (!raw) return undefined;
  sessionStorage.removeItem(QUERY_PREFILL_KEY);
  try {
    return JSON.parse(raw) as Rule;
  } catch {
    return undefined;
  }
}

interface Props {
  initial?: Rule;
  /** The id of the rule `initial` was copied from, sent with the save so the server records the origin. */
  copyFrom?: string;
  allTags: string[];
  categories: Category[];
  /** A Personal rule: no prefill, the save goes to the personal endpoints, and the scope picker offers only scopeLimit. */
  personal?: boolean;
  scopeLimit?: { subscriptions: string[]; managementGroups: string[] };
}

/**
 * Wraps RuleForm on the /rules/new path with the Checks picker (spec 029/032). Skipped when
 * `initial` is already set (duplicating an existing rule) or a query-page prefill is waiting
 * (spec 037's "Save as rule"): the backend is already implicitly chosen in both cases.
 * Otherwise the picker's choice is threaded into RuleForm as initialQueryBackend.
 */
export function RuleNewClient({ initial, copyFrom, allTags, categories, personal = false, scopeLimit }: Props) {
  const router = useRouter();
  const [prefill] = useState(() => initial ?? (personal ? undefined : readQueryPrefill()));
  const [checksConfirmed, setChecksConfirmed] = useState(!!prefill);
  const [queryBackend, setQueryBackend] = useState<QueryBackend>(prefill?.queryBackend ?? 'resource-graph');

  if (!checksConfirmed) {
    return (
      <ChecksPickerDialog
        onSelect={backend => { setQueryBackend(backend); setChecksConfirmed(true); }}
        onClose={() => router.push(personal ? '/library?section=personal' : '/rules')}
      />
    );
  }

  // canAuthor is always true here: the page answers 404 to anyone without the action it needs.
  return (
    <RuleForm
      initial={prefill} copyFrom={copyFrom} initialQueryBackend={queryBackend} allTags={allTags} categories={categories} canAuthor
      personal={personal} scopeLimit={scopeLimit}
    />
  );
}
