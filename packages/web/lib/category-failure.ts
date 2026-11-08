/** What a run records in its `error` when a category's scan threw. One wording, written by the executor and
 *  read back by Run History to tell a category that failed from one whose saved scan has since expired. */
export function categoryFailureMessage(categoryId: string): string {
  return `${categoryId}: scan failed. Check the RuleBeat server logs for details`;
}
