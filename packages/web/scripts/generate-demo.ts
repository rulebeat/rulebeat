// A local shortcut for regenerating the Demo without starting the app. The generator itself lives in
// lib/demo/ and ships in the image, where boot runs it; this only forces a fresh generation.
//
// Deliberately no static imports of anything under lib/ here. `RULEBEAT_DEMO=1` must be set before
// lib/db/client.ts decides which file to open, and a static import is hoisted above the assignment
// below regardless of where it is written in this file.

process.env.RULEBEAT_DEMO = '1';

async function generateDemo(): Promise<void> {
  const { prepareDemoDatabase } = await import('../lib/demo/boot');
  await prepareDemoDatabase({ force: true });
}

generateDemo().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
