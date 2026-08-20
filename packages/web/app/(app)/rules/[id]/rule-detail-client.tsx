'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Lock, Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RuleForm } from '@/components/rules/rule-form';
import { canDuplicateRule } from '@/lib/rule-taxonomy';
import type { Category, Rule } from '@/lib/types';

interface Props {
  rule: Rule;
  kqlQuery?: string;
  initialEditing?: boolean;
  allTags?: string[];
  categories?: Category[];
  /** Whether this person may author rules at all. Built-ins still lock their detection query. */
  canAuthor: boolean;
}

export function RuleDetailClient({ rule, kqlQuery, initialEditing = false, allTags, categories, canAuthor }: Props) {
  const router = useRouter();
  const isBuiltin = rule.type === 'builtin';
  const canDuplicate = canDuplicateRule(rule);
  const [editing, setEditing] = useState(initialEditing && canAuthor);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveHandleRef = useRef<(() => void) | null>(null);

  function handleDuplicate() {
    router.push(`/rules/new?copyFrom=${encodeURIComponent(rule.id)}`);
  }

  return (
    <main className="flex-1 p-4 space-y-4">
      {/* Status bar */}
      <div className="max-w-[1600px] mx-auto flex items-center gap-2 flex-wrap">
        {isBuiltin ? (
          <span className="inline-flex items-center gap-1.5 bg-surface-sunken px-2 py-1 text-xs font-medium text-ink-2">
            <Lock className="h-2.5 w-2.5 shrink-0" />
            Built-in · detection logic read-only, tags and status below are editable
          </span>
        ) : editing ? (
          <>
            <span className="inline-flex items-center gap-1.5 border border-status-warn/40 px-2 py-1 text-xs font-medium text-status-warn">
              Editing
            </span>
            <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => setEditing(false)}>
              Cancel edit
            </Button>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 bg-surface-sunken px-2 py-1 text-xs font-medium text-ink-2">
              Viewing
            </span>
            {canAuthor && (
              <Button variant="outline" size="sm" className="h-6 text-xs px-2 gap-1" onClick={() => setEditing(true)}>
                <Pencil className="h-2.5 w-2.5" />
                Edit
              </Button>
            )}
          </>
        )}
        {canAuthor && (
          <Button
            size="sm"
            className="h-6 text-xs px-2 gap-1"
            disabled={!dirty || saving}
            onClick={() => saveHandleRef.current?.()}
          >
            {saving && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        )}
        {canAuthor && canDuplicate && (
          <Button variant="outline" size="sm" className="h-7 text-xs px-2.5 gap-1.5 ml-auto" onClick={handleDuplicate}>
            <Copy className="h-3 w-3" />
            Duplicate
          </Button>
        )}
      </div>

      {/* Form — readOnly whenever not in edit mode (custom rules only; a built-in never enters
          edit mode, so this stays permanently true for one and locks the detection query). Tags
          and enabled on a built-in are gated by canAuthor instead, independent of editing. Save
          itself lives in the status bar above, beside Edit — RuleForm exposes it through
          saveHandleRef (always the latest field values) and reports dirty/saving up so the
          button is only active when there's something unsaved. */}
      <RuleForm
        initial={rule}
        kqlQuery={kqlQuery}
        readOnly={!editing}
        allTags={allTags}
        categories={categories}
        canAuthor={canAuthor}
        onDirtyChange={setDirty}
        onSavingChange={setSaving}
        saveHandleRef={saveHandleRef}
      />
    </main>
  );
}
