import { auth } from '@/auth';
import { signOutUser } from '@/lib/actions';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';
import { isDemoMode } from '@/lib/demo';

interface HeaderProps {
  title: string;
  description?: string;
}

export async function Header({ title, description }: HeaderProps) {
  const session = await auth();

  // The hairline under the header is the strong rule, matching the sidebar's own edge, so the
  // fixed frame around the page reads as one continuous structure rather than three panels.
  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between gap-6 border-b border-rule-strong bg-surface px-8">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold leading-tight text-ink">
          {title}
        </h1>
        {description && (
          <p className="mt-0.5 truncate text-[13px] leading-tight text-ink-2">
            {description}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {session?.user ? (
          <>
            <div className="flex items-center gap-2.5">
              {session.user.image && (
                // Square, not a circle. Grid has no rounded corners anywhere else, and one round
                // avatar is exactly the kind of stray detail that makes an interface look assembled
                // from parts.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.user.image}
                  alt={session.user.name ?? ''}
                  className="size-8 border border-border object-cover"
                />
              )}
              <span className="hidden whitespace-nowrap text-sm font-medium text-ink md:block">
                {session.user.name}
              </span>
            </div>
            <div className="hidden h-5 w-px bg-border md:block" />
            <form action={signOutUser}>
              <Button variant="ghost" size="icon-sm" type="submit" title="Sign out">
                <LogOut className="size-4" />
              </Button>
            </form>
          </>
        ) : (
          // No session and demo mode: this is an anonymous visitor, not someone who failed to sign
          // in. Fills the slot the avatar/name/sign-out block would otherwise leave empty.
          isDemoMode() && (
            <span className="whitespace-nowrap text-xs font-medium text-ink-2">
              Browsing as viewer
            </span>
          )
        )}
      </div>
    </header>
  );
}
