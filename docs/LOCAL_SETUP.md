# Local setup

## Required environment

```env
GEMINI_API_KEY=...
CONTEXT_DRIVER=clickhouse
REFERENCE_SEARCH_DRIVER=firecrawl
FIRECRAWL_API_KEY=...
PLAYWRIGHT_HEADLESS=true
```

Set `REFERENCE_SEARCH_DRIVER=none` to run without downloaded reference images. Grounded textual research still runs through Gemini.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

## Native development

Use Node 22 or newer.

```bash
npm ci
npx playwright install chromium
docker compose up clickhouse -d
npm run migrate
npm run dev
```

The API and UI are available at http://localhost:8787.

## Failure behavior

A missing Gemini key prevents startup. A malformed Gemini response, invalid anatomical placement, source sandbox violation, TypeScript error, browser error, or failed quality gate is persisted and shown to the user. There is no deterministic scene or placeholder-render mode.
