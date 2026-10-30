# Taksimetre

<div align="center">
  <img src="public/icons/icon-512.png" alt="Taksimetre icon" width="128" />

**A GPS taximeter for estimating Istanbul taxi fares in the browser.**
</div>

## What is Taksimetre?

Taksimetre estimates Istanbul taxi fares during a ride. It uses the phone's GPS together with the official İBB tariff parameters. It runs in the browser without an account and can be installed as an offline-capable app.

It is **not a certified taximeter**. Fares are estimates, and the fare shown by the taxi's own meter is what the passenger pays.

The project has not been publicly released yet.

## Features

- Live meter that measures distance and time with foreground GPS.
- Istanbul's S-mode rules: charges for distance above 12.50 km/h and for time below it, applies the minimum fare at the end.
- All four official taxi categories (yellow C, turquoise D, yellow 8-passenger, black E/F).
- Seven-segment LED meter display in portrait and landscape.
- Turkish and English; system, light and dark themes.
- Handles GPS signal loss conservatively: unmeasured time and distance are not charged.
- Active journey survives page reloads.
- Installable PWA that launches offline and never updates during a journey.
- No backend, accounts, analytics or location storage.

## How It Works

1. The passenger chooses a taxi category and presses **BAŞLAT** when the ride starts.
2. GPS fixes are filtered for accuracy, jumps and stationary drift.
3. The fare engine charges whole 100 m or 1 min steps in integer kuruş using the tariff in force.
4. **BİTİR** ends the journey and shows the payable fare with the minimum applied.

## Tech Stack

- **Application:** TypeScript (strict), Vite, vanilla CSS, no runtime dependencies
- **Offline:** hand-written service worker generated at build time
- **Tests:** Vitest and Playwright
- **CI:** GitHub Actions, with GitHub Pages as a prepared deployment target

## Getting Started

Requirements:

- Node.js 22

```bash
npm ci
npm run dev
```

The development server binds to localhost by default. For explicit LAN testing, use `npm run dev -- --host 0.0.0.0`; use a trusted HTTPS setup for location access on another device.

Open the address shown by Vite. Geolocation needs HTTPS or `localhost`. In development, add `?sim` for a simulated journey; in any build, `?diag` shows GPS statistics without coordinates.

## Development and Testing

```bash
npm run typecheck   # strict TypeScript
npm test            # unit tests (Vitest)
npm run check       # typecheck + unit tests
npx playwright install chromium   # once
npm run e2e         # browser tests (Playwright)
```

The Playwright tests cover the development build, the production build (offline launch and updates), and a GitHub Pages sub-path.

## PWA and Deployment

```bash
npm run build
npm run preview
```

The service worker is only active in production builds. All URLs are relative, so the build works at a domain root or under a sub-path. Regenerate icons with `npm run icons`.

The `Build & Deploy (GitHub Pages)` workflow runs every check on pushes and pull requests. Deployment is off until Pages is set to *GitHub Actions* and the repository variable `PAGES_DEPLOY_ENABLED` is `true`.

## Tariff Verification

The tariffs come from İBB Meclis Kararı No. 813 (17.07.2026), effective 20 July 2026, published on [İBB TUHİM](https://tuhim.ibb.gov.tr/ucret-tarifeler/). They are compiled into the app as versioned data.

The manual `Check Taxi Tariffs` workflow, or `npm run tariff:check` locally, finds the current official PDF and compares every category with the app. It reports `UP TO DATE`, `CHANGES FOUND` or `UNABLE TO VERIFY`. It never changes files.

## Project Structure

```text
Taksimetre/
├── src/
│   ├── engine/          # fare engine and meter states
│   ├── tariff/          # official tariff data and validation
│   ├── gps/             # GPS tracking and filtering
│   ├── journey/         # journey persistence
│   ├── pwa/             # service worker and updates
│   ├── ui/              # meter display and interface
│   └── dev/             # development simulator
├── public/              # manifest and icons
├── scripts/             # icon generator and tariff checker
├── test/                # unit tests and fixtures
├── e2e/                 # Playwright tests
├── docs/TECHNICAL.md    # technical reference
└── .github/workflows/   # CI, deployment and tariff check
```

<div align="center">
  <p>Developed by <a href="https://heykaan.dev">heykaan.dev</a>.</p>
</div>
