import Link from 'next/link';
import { convertedOriginText, versionLabel, type OriginNote } from '@/lib/rule-version-markers';

/**
 * Where a custom rule came from, on the rule's own page. Nothing is shown for a rule with no recorded
 * origin: a rule written from scratch, or a copy made before origins were recorded, is never guessed
 * at (`describeOrigin()` returns null for both).
 */
export function RuleOrigin({ origin }: { origin: OriginNote | null }) {
  if (!origin) return null;

  if (origin.kind === 'converted') {
    return (
      <p className="text-xs text-ink-2">
        {convertedOriginText(origin.version)}
      </p>
    );
  }

  return (
    <p className="text-xs text-ink-2">
      Duplicated from{' '}
      {origin.originName === null ? (
        <>a rule that has since been deleted{origin.version && `, version ${versionLabel(origin.version)}`}.</>
      ) : (
        <>
          <Link
            href={`/rules/${encodeURIComponent(origin.originRuleId)}`}
            className="font-medium text-ink underline-offset-2 hover:underline"
          >
            {origin.originName}
          </Link>
          {origin.version && <> {versionLabel(origin.version)}</>}.
        </>
      )}
      {origin.hasNewerVersion && <> The original has a newer version.</>}
    </p>
  );
}
