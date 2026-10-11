/**
 * The pairing step of the APRL v2 pack transform (`scripts/packs/aprl-v2.ts`, ticket #221). It is
 * pure: parsed recommendations and the text of a folder's `.kql` files go in, the recommendations
 * that ship with their query come out, with no network and no file access, so it is tested with
 * in-memory input.
 *
 * Lives in `lib/` rather than `scripts/` for the same reason as `pack-versioning.ts`: the tests read
 * it, and product code never imports from `scripts/`.
 *
 * Upstream names each `.kql` file after the `aprlGuid` of the recommendation it belongs to, and the
 * pairing uses that name and nothing else. It never hands a file out by position: a skipped
 * recommendation uses no file, so a positional pairing shifts every one after it onto another
 * recommendation's query.
 */

/** A recommendation as `recommendations.yaml` declares it, fields RuleBeat reads only. */
export interface AprlRecommendation {
  aprlGuid?: string;
  description?: string;
  recommendationControl?: string;
  recommendationImpact?: string;
  recommendationResourceType?: string;
  recommendationMetadataState?: string;
  longDescription?: string;
  automationAvailable?: boolean | string;
  query?: string;
  learnMoreLink?: Array<{ name: string; url: string }> | null;
}

export interface PairedRecommendation {
  rec: AprlRecommendation;
  guid: string;
  name: string;
  rawKql: string;
}

export interface AprlPairing {
  /** The recommendations that ship, in the order the YAML lists them. */
  selected: PairedRecommendation[];
  /** Recommendations left out: no guid or name, retired/preview/disabled, no automation, or no query. */
  skipped: number;
  /** Paths of `.kql` files that were paired with nothing because their name is not a guid. */
  unpairedFiles: string[];
}

const GUID_FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.kql$/i;

/**
 * @param recommendations the parsed `recommendations.yaml` of one resource-type folder
 * @param files the folder's `.kql` files: path (ending in the file name) to text
 */
export function pairRecommendations(
  recommendations: AprlRecommendation[],
  files: Record<string, string>,
): AprlPairing {
  const queryByGuid = new Map<string, string>();
  const unpairedFiles: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    const match = GUID_FILE_NAME.exec(path.slice(path.lastIndexOf('/') + 1));
    const guid = match?.[1]?.toLowerCase();
    // A second file for one guid (two spellings of the same name) is not guessed between.
    if (!guid || queryByGuid.has(guid)) { unpairedFiles.push(path); continue; }
    queryByGuid.set(guid, text.trim());
  }

  const selected: PairedRecommendation[] = [];
  let skipped = 0;
  for (const rec of recommendations) {
    const guid = typeof rec.aprlGuid === 'string' ? rec.aprlGuid.trim() : '';
    const name = typeof rec.description === 'string' ? rec.description.trim() : '';
    const state = rec.recommendationMetadataState?.toLowerCase();
    const hasAuto = rec.automationAvailable === true || rec.automationAvailable === 'true';

    if (!guid || !name) { skipped++; continue; }
    if (state === 'retired' || state === 'preview' || state === 'disabled') { skipped++; continue; }
    if (!hasAuto) { skipped++; continue; }

    // An inline query wins; otherwise only the file named after this recommendation's guid.
    const rawKql = rec.query?.trim() || queryByGuid.get(guid.toLowerCase()) || '';
    if (!rawKql) { skipped++; continue; }

    selected.push({ rec, guid, name, rawKql });
  }
  return { selected, skipped, unpairedFiles };
}
