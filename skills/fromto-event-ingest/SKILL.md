---
name: fromto-event-ingest
description: Add or update FromTo events in `events.csv` and map images in `pic/` by event id. Use when the user asks to add historical/current events, fix CSV rows, assign tags, find/download a representative image, name the image as `<id>.<ext>`, and rebuild `pic/manifest.json` with `npm run build`.
---

# FromTo Event Ingest

## Default Mode

Treat this skill as **FULL mode by default**.

When the user asks to "add event", always complete all steps below unless user explicitly says `CSV only`:
1. Add or update the event row in `events.csv`.
2. Source a suitable representative image from a reliable linkable source.
3. Save image as `pic/<id>.<ext>` using id-based mapping.
4. Run `npm run build` to refresh `pic/manifest.json`.
5. Report source URL and license/reuse status in the final response.

Do not stop after CSV update when user did not request `CSV only`.

## Workflow

1. Read current `events.csv` and detect the next available `id`.
2. Add or edit rows using the repo schema:
   `id,name,tag,description,date,time,timezone`
3. Validate row rules before saving:
   - `id`: required, unique, stable
   - `date`: required `YYYY-MM-DD`
   - `time`: optional `HH:mm` (empty means date-only event)
   - `timezone`: optional integer offset `-12..+12`
4. For an event image, map strictly by id:
   - save as `pic/<id>.<ext>` where ext is one of `jpg,jpeg,png,webp,gif,avif`
5. Run `npm run build` after image changes to regenerate `pic/manifest.json`.
6. In final response, include:
   - updated event id
   - saved image path
   - image source URL
   - stated license/reuse status

## Sourcing Guidance

- Prefer reliable, linkable sources (for example, Wikimedia Commons or official archives).
- Record source URL in the response when an image is added.
- Prefer files with clear reuse rights or public-domain status.
- If license/reuse status is unclear, pause and ask before adding the file.
- Match image semantics to event semantics:
  - For "first broadcast" events, prioritize original-era TV promo/poster/title-card/logo assets.
  - Avoid modern commemorative statue photos unless the event itself is about statues/exhibitions.

## Safety Checks

- Never reuse an existing `id` for a different event.
- Do not change old ids unless explicitly asked.
- If the event date/time is uncertain, use date-only and note the assumption.
- Keep `tag` consistent (`History`, `Donald Trump`, etc.) unless user requests new tags.
