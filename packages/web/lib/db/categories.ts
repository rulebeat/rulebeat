import { db } from './client';
import { categories } from './schema';
import { eq, asc } from 'drizzle-orm';
import type { Category } from '@/lib/types';

function rowToCategory(row: typeof categories.$inferSelect): Category {
  return {
    id: row.id,
    label: row.label,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    sortOrder: row.sortOrder,
    isBuiltin: row.isBuiltin ?? false,
    createdAt: row.createdAt,
  };
}

export function listCategories(): Category[] {
  return db.select().from(categories).orderBy(asc(categories.sortOrder)).all().map(rowToCategory);
}

export function getCategory(id: string): Category | null {
  const row = db.select().from(categories).where(eq(categories.id, id)).get();
  return row ? rowToCategory(row) : null;
}

function isLabelTaken(label: string, excludeId?: string): boolean {
  return db.select().from(categories).all()
    .some(c => c.label.trim().toLowerCase() === label.trim().toLowerCase() && c.id !== excludeId);
}

function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function createCategory(data: { label: string; color?: string; icon?: string }): { category: Category } | { error: string } {
  if (!data.label.trim()) return { error: 'Label is required.' };
  if (isLabelTaken(data.label)) return { error: `A category named "${data.label}" already exists.` };

  const id = slugify(data.label);
  if (!id) return { error: 'Label must contain at least one alphanumeric character.' };
  if (getCategory(id)) return { error: `A category with id "${id}" already exists.` };

  const maxOrder = db.select().from(categories).all().reduce((m, c) => Math.max(m, c.sortOrder), 0);

  db.insert(categories).values({
    id,
    label: data.label.trim(),
    color: data.color ?? null,
    icon: data.icon ?? null,
    sortOrder: maxOrder + 1,
    isBuiltin: false,
    createdAt: new Date().toISOString(),
  }).run();

  return { category: getCategory(id)! };
}

export function updateCategory(
  id: string,
  data: Partial<{ label: string; color: string; icon: string; sortOrder: number }>,
): { category: Category } | { error: string } | null {
  const existing = getCategory(id);
  if (!existing) return null;

  if (data.label !== undefined) {
    const trimmed = data.label.trim();
    if (!trimmed) return { error: 'Label cannot be empty.' };
    if (isLabelTaken(trimmed, id)) return { error: `A category named "${trimmed}" already exists.` };
    data = { ...data, label: trimmed };
  }

  db.update(categories).set({
    ...(data.label !== undefined && { label: data.label }),
    ...(data.color !== undefined && { color: data.color }),
    ...(data.icon !== undefined && { icon: data.icon }),
    ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
  }).where(eq(categories.id, id)).run();

  return { category: getCategory(id)! };
}

export function deleteCategory(id: string): boolean | 'builtin' | 'notfound' {
  const row = db.select().from(categories).where(eq(categories.id, id)).get();
  if (!row) return 'notfound';
  if (row.isBuiltin) return 'builtin';
  db.delete(categories).where(eq(categories.id, id)).run();
  return true;
}
