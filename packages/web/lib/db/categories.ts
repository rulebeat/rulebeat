import { db } from './client';
import { categories } from './tables';
import { eq, asc } from 'drizzle-orm';
import { many, one, run } from './exec';
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

export async function listCategories(): Promise<Category[]> {
  const rows = await many(db.select().from(categories).orderBy(asc(categories.sortOrder)));
  return rows.map(rowToCategory);
}

export async function getCategory(id: string): Promise<Category | null> {
  const row = await one(db.select().from(categories).where(eq(categories.id, id)));
  return row ? rowToCategory(row) : null;
}

async function isLabelTaken(label: string, excludeId?: string): Promise<boolean> {
  const all = await many(db.select().from(categories));
  return all.some(c => c.label.trim().toLowerCase() === label.trim().toLowerCase() && c.id !== excludeId);
}

function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function createCategory(data: { label: string; color?: string; icon?: string }): Promise<{ category: Category } | { error: string }> {
  if (!data.label.trim()) return { error: 'Label is required.' };
  if (await isLabelTaken(data.label)) return { error: `A category named "${data.label}" already exists.` };

  const id = slugify(data.label);
  if (!id) return { error: 'Label must contain at least one alphanumeric character.' };
  if (await getCategory(id)) return { error: `A category with id "${id}" already exists.` };

  const maxOrder = (await many(db.select().from(categories))).reduce((m, c) => Math.max(m, c.sortOrder), 0);

  await run(db.insert(categories).values({
    id,
    label: data.label.trim(),
    color: data.color ?? null,
    icon: data.icon ?? null,
    sortOrder: maxOrder + 1,
    isBuiltin: false,
    createdAt: new Date().toISOString(),
  }));

  return { category: (await getCategory(id))! };
}

export async function updateCategory(
  id: string,
  data: Partial<{ label: string; color: string; icon: string; sortOrder: number }>,
): Promise<{ category: Category } | { error: string } | null> {
  const existing = await getCategory(id);
  if (!existing) return null;

  if (data.label !== undefined) {
    const trimmed = data.label.trim();
    if (!trimmed) return { error: 'Label cannot be empty.' };
    if (await isLabelTaken(trimmed, id)) return { error: `A category named "${trimmed}" already exists.` };
    data = { ...data, label: trimmed };
  }

  await run(db.update(categories).set({
    ...(data.label !== undefined && { label: data.label }),
    ...(data.color !== undefined && { color: data.color }),
    ...(data.icon !== undefined && { icon: data.icon }),
    ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
  }).where(eq(categories.id, id)));

  return { category: (await getCategory(id))! };
}

export async function deleteCategory(id: string): Promise<boolean | 'builtin' | 'notfound'> {
  const row = await one(db.select().from(categories).where(eq(categories.id, id)));
  if (!row) return 'notfound';
  if (row.isBuiltin) return 'builtin';
  await run(db.delete(categories).where(eq(categories.id, id)));
  return true;
}
