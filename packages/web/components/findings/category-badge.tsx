import { cn } from '@/lib/utils';

export interface CategoryBadgeCategory {
  id: string;
  label: string;
  color?: string;
}

/* A category is a label, not a measurement, so it is drawn in ink with the user's own
 * colour reduced to a small square marker. Tinting the whole chip put two colour systems
 * on the same line as the severity badge and neither read.
 *
 * Deliberately the same shape as SeverityBadge: a square swatch, a gap, the name, no box.
 * Both are labels sitting in a table cell that already has its own edges, so a border
 * around one of them and not the other was the only thing telling them apart. This is now
 * the single rendering of a category on every screen, including the Library table. */
export function CategoryBadge({ id, categories, className }: {
  id: string;
  categories: CategoryBadgeCategory[];
  className?: string;
}) {
  const cat = categories.find(c => c.id === id);
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-2 whitespace-nowrap text-xs font-medium capitalize text-ink-2',
        className,
      )}
    >
      {cat?.color && (
        <span aria-hidden="true" className="size-2 shrink-0" style={{ backgroundColor: cat.color }} />
      )}
      {cat?.label ?? id}
    </span>
  );
}
