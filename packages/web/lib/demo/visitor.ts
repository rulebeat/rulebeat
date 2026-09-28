import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { run as execRun } from '../db/exec';
import { users } from '../db/tables';
import { createUser } from '../db/users';
import { DEMO_VISITOR_ID } from './index';

/**
 * Seeds the Demo Visitor: the one account every Visitor acts as. An ordinary admin row, so the rest
 * of the console treats it like any other signed-in admin; lib/demo/locked.ts is what narrows it.
 */
export async function seedDemoVisitor(): Promise<void> {
  const result = await createUser({ email: 'demo-visitor@rulebeat.local', role: 'admin' });
  if ('error' in result) throw new Error(`Failed to seed demo visitor: ${result.error}`);
  await execRun(db.update(users).set({ id: DEMO_VISITOR_ID }).where(eq(users.id, result.user.id)));
}
