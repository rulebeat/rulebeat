import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RULE_FORM_SAVE_NOTE } from '@/lib/widget-limits';

interface Props {
  disabled: boolean;
  saving: boolean;
  onSave: () => void;
}

/** Save for the edit pages' status bar, with the limit on what saving does to posture beside it. */
export function RuleSaveAction({ disabled, saving, onSave }: Props) {
  return (
    <>
      <Button size="sm" className="h-6 text-xs px-2 gap-1" disabled={disabled} onClick={onSave}>
        {saving && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
      <p className="text-xs text-ink-2">{RULE_FORM_SAVE_NOTE}</p>
    </>
  );
}
