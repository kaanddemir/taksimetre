# Technical Reference

Developer reference for Taksimetre. Setup and commands are in the [README](../README.md).

## 1. Architecture

The app is a single-screen web app built with Vite, strict TypeScript and vanilla CSS. It has no UI framework, no runtime dependencies and no backend.

| Module | Responsibility |
|---|---|
| `src/tariff/` | Official tariff data, validation, selection by date |
| `src/engine/` | Pure fare engine and meter state machine |
| `src/gps/` | GPS tracking, filtering, wake lock, diagnostics |
| `src/journey/` | Saving and restoring the active journey |
| `src/ui/` | Meter store, view model, LED display, i18n, theme |
| `src/pwa/` | Service worker template and update logic |
| `src/dev/` | Simulator (`?sim`), development builds only |
| `src/index.ts` | Engine entry point used by tests |
| `scripts/` | Icon generator and tariff checker |

Data flow:

```
GPS fix → filter → measurement → MeterStore → engine → view
```

The GPS layer never calculates money. All timestamps use `performance.now()`.

**Storage and privacy**

- `localStorage`: `lang`, `category` and `theme` only.
- `sessionStorage`: the active journey's meter state only.
- No trip history, stored coordinates, analytics or third-party requests.

## 2. Tariffs

**Official source:** İBB, *Taksi Taşımacılığı Segmentleri ve Ücret Tarifesi*, Meclis Kararı **No. 813** (17.07.2026), effective **20.07.2026**.

- Index: [TUHİM Ücret Tarifeleri](https://tuhim.ibb.gov.tr/ucret-tarifeler/)
- Document: [PDF](https://tuhim.ibb.gov.tr/media/27494/taksi-ta%C5%9F%C4%B1mac%C4%B1l%C4%B1%C4%9F%C4%B1-%C3%BCcret-tarifesi.pdf)
- Test copy: `test/fixtures/tariff/`
- Data: `src/tariff/istanbul.ts`

All categories use 100 m and 1 min steps and a crossover speed of 12.50 km/h. Amounts are in TL; the app stores them as integer kuruş.

| Id | Category (UKOME) | Opening | 100 m | 1 min | TL/km | TL/h | Minimum |
|---|---|---|---|---|---|---|---|
| `ist-yellow-c-2026-07-20` | Yellow, "C" segment+ (2022/6-20) | 71.94 | 4.80 | 9.98 | 47.92 | 598.90 | 230.00 |
| `ist-turquoise-d-2026-07-20` | Turquoise, "D" and 8+1 (2022/6-20) | 82.73 | 5.51 | 11.47 | 55.10 | 688.72 | 265.00 |
| `ist-yellow-8pax-2026-07-20` | Yellow, 8 passengers (2022/12-19.B) | 93.52 | 6.23 | 12.97 | 62.29 | 778.56 | 300.00 |
| `ist-black-ef-2026-07-20` | Black, "E"/"F" and 8+1 (2022/6-20) | 122.30 | 8.15 | 16.96 | 81.46 | 1018.12 | 400.00 |

**Notes**

- The engine bills the published unit steps. The km and hourly rates are used only for display and validation, because they are rounded separately (10 × 4.80 = 48.00 vs 47.92).
- The document does not cover tolls, night tariffs, partial steps, rounding or mode switching.

**Adding a tariff version**

1. Add a new entry with a new `id` and `effectiveFrom` to `ISTANBUL_TARIFFS`. Never edit a published entry.
2. Run the tests. `validateRegistry` rejects invalid values, step fares more than 2 % off the published rates, a minimum below the opening fare, and duplicate ids or dates.
3. Release an app update. Tariffs are compiled into the bundle, so users only get new values through an update.

`selectTariff` picks the latest version in force on the Istanbul date (UTC+3). If no tariff is in force, the app shows "Tarife yok". The info panel shows the decision and effective date in use.

## 3. Fare Engine

Source: `src/engine/`. The engine is pure: no DOM, GPS or network.

**Model: S mode.** Each interval is charged by distance **or** by time, never both.

- Above 12.50 km/h: distance mode.
- Below 12.50 km/h: time mode.
- Exactly 12.50 km/h: distance mode (configurable).

Distance and time accumulate in integer remainders. Each full 100 m or 1 min adds one step:

```
meterFare = opening + distanceSteps × unitDistanceFare + timeSteps × unitTimeFare
```

**Input** (`src/engine/measurement.ts`): `{ atMs, distanceMm, speedKmh }` per interval.

- Integer milliseconds and millimetres only. Timestamps must not go backwards.
- Speed alone decides the mode.
- Invalid input is rejected, never corrected. This includes NaN, negative values, distance without time, and journeys over 48 h or 5,000 km.

**States** (`src/engine/meter.ts`):

```
SERBEST --start--> MESGUL --finalize--> UCRET --clear--> SERBEST
                              UCRET --resume--> MESGUL
```

- `transition(state, command)` is pure. A rejected command returns the same state, so duplicates cannot double-charge.
- The tariff is frozen when the journey starts.
- `clear` works only from UCRET, after the fare has been shown for 10 s.
- Time spent in UCRET is not charged.
- Extras (e.g. tolls) are kept separate from the meter fare.
- `gap` marks unknown time: nothing is charged, but the gap is counted.

**Fare output** (`src/engine/fare.ts`)

- `readMeter`: live meter fare, distance, elapsed time and slow time. Never includes the minimum.
- `payable`: `max(meterFare, minimum)` plus extras.

**Assumptions** (`src/engine/policy.ts`)

The official document does not define these behaviours. They need a comparison with a certified meter.

| Behaviour | Default |
|---|---|
| Partial step on a mode switch | Carried over |
| Speed exactly 12.50 km/h | Distance |
| First increment | After the first full 100 m or 1 min |
| Minimum fare | Applied to the payable amount only |
| Final-fare display | 10 s before clearing |
| Time in UCRET before resuming | Not charged |

**Worked examples** (yellow C, covered by tests)

| Journey | Fare |
|---|---|
| 1 km | 119.94 meter → **230.00** payable (minimum) |
| 10 km above 12.5 km/h | **551.94** |
| 15 min stopped | **221.64** |
| 10 km + 15 min slow | **701.64** |
| 3 km at 40 km/h + 2.5 min stopped | **235.90** (30 s carried over) |

**Not supported:** night, holiday, D-mode and tiered tariffs (none exist in Istanbul today). `simulateSegments` can run the engine over route segments for a future fare preview, but it has no UI.

## 4. GPS

Source: `src/gps/`. Thresholds are in `DEFAULT_GPS_CONFIG` (`processor.ts`).

The app uses `watchPosition` with high accuracy. It needs HTTPS and asks for permission only when BAŞLAT is pressed.

**Tracking is foreground-only.** Browsers suspend hidden or locked pages, so there is no reliable background location on the web.

**Filtering.** These thresholds are provisional and need tuning on real devices.

| Rule | Value |
|---|---|
| Reject stale fixes | Older than 10 s |
| Reject inaccurate fixes | Accuracy worse than 35 m |
| Reject jumps | Implied speed above 200 km/h |
| Movement threshold | Based on fix accuracy, 5–30 m |
| Speed source | Device speed, otherwise a 5 s displacement window |
| Minimum moving speed | 8 km/h before distance is credited |

Invalid, duplicate and out-of-order fixes are also rejected. Distance is only credited once movement clears the threshold, so a parked phone does not accumulate distance.

**Signal loss**

- After 5 s without a usable fix, the status is "weak".
- After 15 s, the journey is "interrupted".

**Interruptions are never charged.** Signal loss, a hidden page, revoked permission or a reload is recorded as a gap. No time or distance is added for a gap. Interruptions can therefore lower the estimate, while GPS noise can raise it.

**Other behaviour**

- The meter starts at the first usable fix. If permission is denied, GPS is unavailable or no fix arrives within 30 s, no journey is created.
- Hidden pages stop the location watcher and polling. Returning starts one fresh watcher for an interrupted active journey; the first fix is a baseline and the gap is uncharged. Acquisition is cancelled while hidden and needs a fresh tap.
- Wake Lock keeps the screen on during a journey where supported. It does not enable background tracking.
- `?diag` shows aggregate GPS statistics for field tests. It never shows coordinates.

## 5. Journey Persistence

Source: `src/journey/persist.ts`.

The active journey is saved to `sessionStorage`: meter state only, no coordinates. It is saved on every state change, every 5 s while running, and when the page is hidden.

**On reload**

- The saved record is validated. Records that are invalid or older than 12 h are deleted.
- **MESGUL:** the downtime is recorded as an uncharged gap. GPS reconnects automatically if permission is still granted.
- **UCRET:** the final fare is restored.

The saved journey is cleared when the meter returns to SERBEST.

**Limitation:** a journey survives reloads and short suspensions. It is lost if the tab is closed or the OS kills the app, as iOS may do with suspended home-screen apps.

## 6. PWA

Sources:

- `vite.config.ts`: `pwaPlugin`, generates the service worker
- `src/pwa/`: worker template, registration and updates
- `public/`: manifest and icons

**Build.** After each build, the plugin hashes the output and writes `dist/sw.js` with a version and a file list. An unchanged rebuild produces the same version. All URLs are relative (`base: "./"`), so the build works at any domain or sub-path.

**Manifest and icons**

- Name "Taksimetre", Turkish by default, standalone display, no orientation lock.
- Icons: 192 and 512 px (standard and maskable), a 180 px Apple touch icon and an SVG favicon.
- Regenerate the icons with `npm run icons`.

**Caching**

- Each build and deployment scope has its own cache, filled at install.
- Requests are served cache-first from the current version's cache. Navigations get the app shell.
- Nothing is cached at runtime, so the cache never contains user data.
- Old caches in the same deployment scope are deleted when a new version activates; sibling deployments are isolated.

**Update safety**

- New versions install in the background and wait.
- A page requests activation only when the meter is idle and hidden. The worker also requires it to be the only window in scope. The page reloads once; a hidden idle page retries while another window remains open.
- Existing active journeys and displayed fares defer reloads; forced updates are blocked while another window exists. The client-count snapshot has a concurrent-new-window limitation, documented in [SECURITY.md](SECURITY.md).
- The app checks for updates when it returns to the foreground, at most once an hour.

**Host requirements**

- HTTPS
- Static files only
- `sw.js` not cached for long
- `.webmanifest` served as `application/manifest+json`

**Platform notes** (not yet verified on devices)

- iOS home-screen apps have storage separate from Safari.
- iOS has no install prompt; users add the app with Share → Add to Home Screen.
- iOS may ask for location permission again and may clear the cache of unused apps.
- Wake Lock is unreliable in iOS home-screen apps before iOS 18.4, and Android battery saver may block it.

## 7. GitHub Actions

Both workflows are in `.github/workflows/` and run only on manual dispatch (`workflow_dispatch`). Start them with **Run workflow** in the Actions tab; pushes and pull requests do not start them. Their structure is tested by `test/workflows.test.ts`.

### Build & Deploy (GitHub Pages) — `deploy.yml`

- **Trigger:** manual runs only (`workflow_dispatch`).
- **`verify` job:** `npm ci`, typecheck, unit tests, Playwright, production build, and an output check.
- **`deploy` job:** deploys to GitHub Pages only when:
  - `verify` passed;
  - the event is `workflow_dispatch` and the selected branch is `main`.

**To enable deployment**

1. Settings → Pages → Source: **GitHub Actions**.
2. Actions → **Build & Deploy (GitHub Pages)** → **Run workflow** → select `main` → **Run workflow**.

No repository variable is required. Runs on other branches check the build but do not publish.

**Domains.** No domain or repository name is hard-coded, and the sub-path setup is tested under `/example-repo/`. A custom domain can be set later in the Pages settings. It counts as a new origin, so installs, preferences and the offline cache start fresh there.

### Check Taxi Tariffs — `check-tariffs.yml`

A manual, read-only workflow that compares the official tariff with the app. Source: `scripts/tariff-check/`. Run it locally with `npm run tariff:check`.

1. Finds the taxi tariff PDF on the TUHİM index page. Exactly one match is required.
2. Extracts the PDF text without external dependencies.
3. Parses the decision, the dates and every category, and validates the values.
4. Compares 13 fields per category exactly with the app's tariff.

The optional `pdf_url` input skips discovery. It only accepts `https://*.ibb.gov.tr/` addresses.

| Result | Job | Meaning |
|---|---|---|
| UP TO DATE | Passes | All values match |
| CHANGES FOUND | Fails | The summary lists the differences |
| UNABLE TO VERIFY | Fails | The source could not be read; not proof the app is current |

The run summary shows the source, its hash, the decision, the dates and any differences. The `tariff-report` artifact contains the full report, a JSON version, the extracted text and the PDF.

The workflow never edits files, commits, opens pull requests or deploys. Changes must be added by a person as a new tariff version. If İBB redesigns the PDF, the check reports UNABLE TO VERIFY until the parser is updated.

## 8. Testing

| Suite | Command | Coverage |
|---|---|---|
| Vitest (`test/`) | `npm test` | Engine, tariffs, GPS filter, persistence, GPS replay, UI logic, updates, tariff checker, workflows |
| Playwright (`e2e/`) | `npm run e2e` | Layouts, GPS states, theme, info panel, production build, offline launch, safe updates, Pages sub-path |

Playwright starts its own servers on ports 5173, 4173 and 4174. Screenshots go to `e2e/.shots/`, which Git ignores.

### Real-Device Testing

**Not yet performed.**

1. Run `npm run build && npx vite preview --port 4173`.
2. Expose it over HTTPS with a temporary tunnel, for example `npx cloudflared tunnel --url http://localhost:4173`.
3. Add `?diag` to the URL.

Test on iPhone Safari, the iPhone home-screen app, Android Chrome and the Android installed app. Record the device, OS and browser for each run. Do not operate the phone while driving.

| Check | Expected result |
|---|---|
| Install and launch | Correct name and icon, standalone, no notch overlap |
| Offline launch | Opens in airplane mode after one online visit |
| Permission | Asked only on BAŞLAT. Denial creates no journey |
| Stationary 10 min | Distance ≈ 0, only time charged |
| Real ride ≥ 15 min | Plausible distance; tunnels appear as gaps |
| Weak signal | Warnings appear and clear; the fare does not jump |
| Lock or app switch, 60 s | Gap recorded, journey continues |
| Screen awake, 10 min | Wake Lock keeps the screen on |
| Rotation | Fare and time unchanged |
| 60 min session | No slowdown; note battery use |
| Reload / force-quit | Reload keeps the fare; force-quit loses the journey |
| Update between journeys | No reload during a journey; new version shown afterwards |

### Certified-Taximeter Comparison

**Not yet performed.**

- Ride at least 20 trips with the app next to a certified meter. Include short and long trips, heavy traffic, long waits and tunnels, on both iOS and Android.
- Record both fares, the `?diag` output, the phone and the conditions.
- Report the median and worst-case fare error, measured before the minimum fare is applied.
- A consistent ±1 step difference may mean one of the assumptions in §3 is wrong.
- Engineering targets (not legal tolerances): median distance error ≤ 3 %, median fare error ≤ 5 %.

### Application release version

The current application version is **1.0.0** (Taksimetre 1.0). `package.json` is the source for the About panel in both development and production; the lockfile root metadata matches it. The service worker's content-derived `VERSION` identifies a cache build, not an application release. Journey schema versions, tariff identifiers and dependency/action versions are independent.
