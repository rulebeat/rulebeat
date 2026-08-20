const LEARN_MORE_MARKER = '\nLearn more: ';

/** Rule descriptions optionally carry a trailing "\nLearn more: <url>" marker (APRL docs links).
 *  Splits it out so callers can render the prose and the link separately. */
export function splitLearnMore(description: string | null | undefined): { text: string; url: string | null } {
  if (!description) return { text: '', url: null };
  const idx = description.indexOf(LEARN_MORE_MARKER);
  if (idx < 0) return { text: description, url: null };
  return { text: description.slice(0, idx), url: description.slice(idx + LEARN_MORE_MARKER.length).trim() };
}
