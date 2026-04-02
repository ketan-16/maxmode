# MaxMode

A no-BS, self-hosted weight and calorie tracker built with FastAPI + Jinja templates and offline-first frontend behavior.

## Architecture

- Backend: `main.py` serves full templates and HTMX partials.
- Frontend bootstrap: `static/js/bootstrap.mjs` (exports `window.MaxMode` API compatibility layer).
- Frontend modules:
  - `static/js/modules/storage.mjs`: localStorage-backed state snapshot (`loadState`) and mutations.
  - `static/js/modules/data-utils.mjs`: pure weight/chart/date utilities.
  - `static/js/modules/charts.mjs`: dashboard/weights SVG chart rendering.
  - `static/js/views/dashboard-ui.mjs`: dashboard metric rendering.
  - `static/js/views/weights-ui.mjs`: weights list/chart/modal/delete UI.
  - `static/js/views/profile-ui.mjs`: profile + avatar rendering.
- HTMX compatibility layer: `static/vendor/htmx.min.js` (self-hosted).
- PWA worker: `service-worker.js` with safe caching rules and update handling.

## Run

```bash
uv run uvicorn main:app --reload
```

Open: `http://127.0.0.1:8000`

## AI Meal Parsing

- The calorie tracker uses `LiteLLM` for provider-agnostic meal estimation.
- Current dev/test default: set `OPENAI_API_KEY` in `.env`.
- OpenAI-backed meal estimation now uses the Responses API with built-in web search enabled, and shows the supporting web sources in the confirmation sheet.
- Optional provider override: set `MEAL_AI_MODEL` (for example `anthropic/...`, `openai/...`, or `vertex_ai/...`).

## Test

Backend route/rendering tests:

```bash
uv run python -m unittest discover -s tests -v
```

Frontend pure utility tests:

```bash
node --test tests_frontend/*.test.mjs
```

## Regression Checklist

1. Load `/`, `/weights`, `/profile` online.
2. Add/edit/delete weight entries and verify chart + dashboard + profile updates.
3. Switch chart ranges (`7D`, `30D`, `90D`, `All`) and verify chart redraw.
4. Refresh with service worker active and confirm app still loads offline.
5. Verify `HX-Request` partial swaps update only `#main-content`.
