# FromTo

A frontend-only SPA for tracking memorable events:
- Future events: countdown phrase
- Past events: elapsed-time phrase

## Run Locally

Serve this folder with a local static server (do not open via `file://`):

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Data Source

Events are loaded from `events.csv`.

CSV header:

```csv
id,name,tag,description,date,time,timezone
```

Fields:
- `id`: unique event id (used for image mapping)
- `name`: event title
- `tag`: used for sidebar tag filter
- `description`: optional
- `date`: required, format `YYYY-MM-DD`
- `time`: optional, format `HH:mm`
- `timezone`: optional integer offset from `-12` to `+12`

Rules:
- If `time` is empty, event is treated as date-only.
- If `timezone` is empty, event is interpreted in user local timezone.
- If `timezone` is set, event is interpreted as fixed UTC offset time.

## Image Mapping

Images are loaded from `pic/` by **event id**.

For an event with `id=7`, supported filenames are:
- `7.jpg`
- `7.jpeg`
- `7.png`
- `7.webp`
- `7.gif`
- `7.avif`

The app reads `pic/manifest.json` to avoid 404 probing.

## Build Step

Run:

```bash
npm run build
```

This regenerates `pic/manifest.json` from files in `pic/`.
