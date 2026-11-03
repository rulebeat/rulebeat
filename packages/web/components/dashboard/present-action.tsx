'use client';

import { Presentation } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { presentHref } from '@/lib/present';

/**
 * The toolbar's Present action. It opens Present in this tab with the address's filters, and is not there
 * during an edit session: Present shows what is saved, so it would show the layout being edited as it was.
 */
export function PresentAction({ dashboardId, editMode }: { dashboardId: string; editMode: boolean }) {
  const router = useRouter();
  if (editMode) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5"
      onClick={() => router.push(presentHref(dashboardId, new URLSearchParams(window.location.search)))}
    >
      <Presentation className="size-3.5" />Present
    </Button>
  );
}
