/**
 * The shape of an entry in data/packs/pack-manifest.json as the Library page reads it. This lives
 * beside the page rather than in `page.tsx` because a Next.js page file may export only the page
 * itself, and the client component needs the guard as a value.
 */
export interface PackManifestEntry {
  label: string;
  /** The rest describe an external pack. RuleBeat Core has an entry for its version scheme only. */
  source?: string;
  license?: string;
  attribution?: string;
  pinnedCommit?: string;
  syncedAt?: string;
  policyCount?: number;
}

/** A manifest entry that carries everything the pack info banner shows. */
export type ExternalPackManifestEntry = PackManifestEntry & Required<Omit<PackManifestEntry, 'label'>>;

export function isExternalPack(entry: PackManifestEntry | undefined): entry is ExternalPackManifestEntry {
  return entry !== undefined
    && !!entry.source && !!entry.license && !!entry.attribution && !!entry.pinnedCommit && !!entry.syncedAt
    && entry.policyCount !== undefined;
}
