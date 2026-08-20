'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input, Label } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';

export function ChangePasswordClient({
  email, mustChangePassword,
}: {
  email: string;
  mustChangePassword: boolean;
}) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 15) { setError('Use at least 15 characters.'); return; }
    if (newPassword !== confirm) { setError('Passwords do not match.'); return; }

    setBusy(true);
    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: mustChangePassword ? undefined : currentPassword,
          newPassword,
        }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? 'Could not change the password.');
        return;
      }
      // Not /dashboard: this mutation just bumped the account's sessionEpoch (spec 020), which
      // makes the token this page is running under stale immediately — the layout redirect would
      // just bounce back to /signin anyway. Send the user through a real sign-in with the new
      // password instead of pretending the old session can continue.
      router.replace('/signin?passwordChanged=1');
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken">
      <div className="w-full max-w-sm px-6">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/brand/mark.png" alt="RuleBeat" className="mb-5 size-12 shrink-0 dark:hidden" />
          <img src="/brand/mark-dark.png" alt="RuleBeat" className="mb-5 hidden size-12 shrink-0 dark:block" />
          <h1 className="font-heading text-2xl font-bold tracking-tight text-ink">
            {mustChangePassword ? 'Set a new password' : 'Change your password'}
          </h1>
          <p className="mt-1.5 text-sm text-ink">{email}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 bg-surface p-6">
          {mustChangePassword && (
            <p className="text-xs leading-relaxed text-ink-2">
              This account was created with a temporary password. Choose a new one to continue.
            </p>
          )}
          {error && <Callout tone="error">{error}</Callout>}
          {!mustChangePassword && (
            <div className="space-y-1.5">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              minLength={15}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
              minLength={15}
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Set password
          </Button>
        </form>
      </div>
    </div>
  );
}
