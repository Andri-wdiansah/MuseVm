# MuseVm — Muse & VM Status Dashboard

Dark, orange-accented status dashboard for Muse and its VM, styled after the
reference video (dark theme, vivid orange accent, sidebar layout, animated
charts). It shows VM resources (CPU load, memory, disk, uptime), Muse
subscription and token usage with history, connected services (GitHub,
Vercel), and Vercel deployments.

## Layout

- `site/` — static dashboard (`index.html`, `styles.css`, `app.js`, `data.json`)
- `collect.py` — collects VM metrics, subscription status, and connector
  status; appends hourly token snapshots to `history.json`
- `deploy.py` — collects fresh data and deploys the site to Vercel

## Data

Data is a periodic snapshot, not live: Vercel cannot reach the VM directly,
so the collector pushes fresh snapshots on a schedule. Token history starts
from the first snapshot and grows as snapshots accumulate.

## Status

Vercel deploy is currently blocked by team-scope authorization (403, scope
`aw-rnd95`); the local version runs as a Muse Space meanwhile.
