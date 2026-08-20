'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RuleForm } from '@/components/rules/rule-form';
import { ChecksPickerDialog } from '@/components/rules/checks-picker-dialog';
import type { Category, QueryBackend, Rule } from '@/lib/types';

// Written by the live Query page's "Save as rule" action, read once here and cleared immediately —
// a page refresh after landing on /rules/new must not re-trigger the prefill.
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
  allTags: string[];
  categories: Category[];
}

/**
 * Wraps RuleForm on the /rules/new path with the Checks picker (spec 029/032). Skipped when
 * `initial` is already set (duplicating an existing rule) or a query-page prefill is waiting
 * (spec 037's "Save as rule") — the backend is already implicitly chosen in both cases.
 * Otherwise the picker's choice is threaded into RuleForm as initialQueryBackend.
 */
export function RuleNewClient({ initial, allTags, categories }: Props) {
  const router = useRouter();
  const [prefill] = useState(() => initial ?? readQueryPrefill());
  const [checksConfirmed, setChecksConfirmed] = useState(!!prefill);
  const [queryBackend, setQueryBackend] = useState<QueryBackend>(prefill?.queryBackend ?? 'resource-graph');

  if (!checksConfirmed) {
    return (
      <ChecksPickerDialog
        onSelect={backend => { setQueryBackend(backend); setChecksConfirmed(true); }}
        onClose={() => router.push('/rules')}
      />
    );
  }

  return <RuleForm initial={prefill} initialQueryBackend={queryBackend} allTags={allTags} categories={categories} />;
}
