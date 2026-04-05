![Splash](docs/splash.webp)
<br><br>
MaxMode is a local-first calorie and weight tracker for people who want a clean, fast way to log meals, track weight, and stay on top of their goals.

It runs as a web app you can self-host, works offline, and supports optional AI meal logging and optional account sync when you want backup across devices.

## What MaxMode is

MaxMode is a simple tracking app built around everyday use. You can log your weight, set a calorie goal, track macros, and keep a running meal timeline without wading through a bloated interface.

The app is designed to feel quick on mobile, usable on desktop, and reliable even when your connection is spotty.

## Why people use it

- Fast meal logging without a heavy setup process
- Weight trends that are easy to read at a glance
- Calorie and macro guidance based on your goal
- Local-first behavior with built-in offline support
- Optional account sync when you want your data available on more than one device

## What you can do

- See your daily goal, macro split, weight trend, weekly intake, streak, and today's meals from the dashboard
- Log weight entries, review chart ranges, and keep a full weight history
- Log meals from a photo, a short description, or voice input in supported browsers
- Choose goal presets for cutting, maintenance, or bulking
- Set preferences for units, activity level, protein defaults, and AI calculation mode
- Turn on reminder notifications in browsers that support them
- Install the app as a PWA and keep using it offline

## Quick start

1. Make sure you have Python 3.13+ and [`uv`](https://docs.astral.sh/uv/) installed.
2. Install dependencies:

```bash
uv sync
```

3. Start the app:

```bash
uv run uvicorn main:app --reload
```

4. Open [`http://127.0.0.1:8000`](http://127.0.0.1:8000)

On first run, MaxMode creates its SQLite database at `.data/maxmode.sqlite3` and applies the latest migrations automatically.

## Optional AI setup

Core tracking works without AI.

If you want photo, manual, or voice-based meal estimates, add an `OPENAI_API_KEY` to your environment or `.env` file:

```env
OPENAI_API_KEY=your_api_key_here
```

You can also override the default model with `MEAL_AI_MODEL`:

```env
MEAL_AI_MODEL=openai/gpt-5.4-nano
```

## How your data is stored

- MaxMode is local-first, so your data stays on the device by default
- If you create an account, you can sign in and sync your data across devices
- Offline support is built in, so the app can keep working even when you're disconnected

## Optional configuration

- `OPENAI_API_KEY`: enables AI meal estimates
- `MEAL_AI_MODEL`: overrides the default AI model used for meal estimates
- `DATABASE_URL`: points the app at a different database instead of the default `.data/maxmode.sqlite3` SQLite file
- `MAXMODE_ENV`: set to `production` to use secure session cookies

## Development

Stack: FastAPI, Jinja templates, HTMX-style partial navigation, and a local-first frontend with PWA support.

Backend tests:

```bash
uv run python -m unittest discover -s tests -v
```

Frontend tests:

```bash
node --test tests_frontend/*.test.mjs
```
