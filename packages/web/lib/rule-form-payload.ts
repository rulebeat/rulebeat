import type { GraphQuery, LogAnalyticsQuery, QueryBackend } from '@/lib/types';
import type { VisualQuery } from '@/lib/kql';

/** The query-shape fields rule-form.tsx's save() sends, before the caller adds the fields every
 *  backend shares (name/description/scope/etc). Graph and Log Analytics each own a dedicated
 *  editor and must null out the ARG visual/raw-KQL fields *and* each other's field — spec 036's
 *  self-challenge found the pre-fix code gating this on `isGraphBackend` alone in two separate
 *  places, which silently missed the Log Analytics case in one of them. Centralizing the shape
 *  here, rather than repeating the per-backend ternaries at each call site, is what makes that
 *  class of bug structurally impossible to reintroduce for a third backend later. */
export interface RuleFormQueryFields {
  visualQuery: VisualQuery;
  appliesTo: VisualQuery | undefined;
  rawKql: string;
  graphQuery: GraphQuery;
  logsQuery: LogAnalyticsQuery;
}

export interface DedicatedEditorPayloadFields {
  usesDedicatedEditor: boolean;
  visualQuery: VisualQuery | undefined;
  appliesTo: VisualQuery | undefined;
  rawKql: string | undefined;
  graphQuery: GraphQuery | undefined;
  logsQuery: LogAnalyticsQuery | undefined;
}

export function deriveDedicatedEditorFields(
  queryBackend: QueryBackend,
  fields: RuleFormQueryFields,
): DedicatedEditorPayloadFields {
  const isGraphBackend = queryBackend === 'microsoft-graph';
  const isLogAnalyticsBackend = queryBackend === 'log-analytics';
  const usesDedicatedEditor = isGraphBackend || isLogAnalyticsBackend;
  return {
    usesDedicatedEditor,
    visualQuery: usesDedicatedEditor ? undefined : fields.visualQuery,
    appliesTo: usesDedicatedEditor ? undefined : fields.appliesTo,
    rawKql: usesDedicatedEditor ? undefined : (fields.rawKql || undefined),
    graphQuery: isGraphBackend ? fields.graphQuery : undefined,
    logsQuery: isLogAnalyticsBackend ? fields.logsQuery : undefined,
  };
}
