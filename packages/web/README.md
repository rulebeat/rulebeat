# RuleBeat Web

The Next.js app for RuleBeat (product UI + API routes). It imports the scanning engine from `@rulebeat/core`.

For quick-start, self-hosting, and product docs see the **[root README](../../README.md)**.

## Development

```bash
# From repo root
npm install
npm run build:core          # required before web
cp .env.example packages/web/.env.local   # fill in values
az login                    # local Azure access via DefaultAzureCredential
npm run dev                 # http://localhost:3000
```

Typecheck: `npx tsc --noEmit` (from this directory).
