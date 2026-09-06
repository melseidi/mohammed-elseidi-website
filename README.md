# mohammed-elseidi-website

Personal academic website of Dr. Mohammed Elseidi — Associate Professor of Statistics &
Data Science and Director of Quality Assurance, Umm Al Quwain University.

A static site, served straight from this repository by GitHub Pages. No build step and no
backend. Fonts are self-hosted and icons are inline SVG, so the only third-party request on a
normal page load is the poster image for the recorded YouTube talk (`i.ytimg.com`, loaded
lazily); the YouTube player (on play), the Google Drive copy of the portrait (only if
`assets/profile.jpg` fails to load) and SheetJS (only for `.xlsx` uploads in the Lab) are
fetched on demand.

## Pages

| File | What it is |
|------|------------|
| `index.html` | The main CV site — about, publications, Forecast Lab feature, career, awards, service, talks & media, skills, contact |
| `forecast-lab.html` | **Forecast Lab** — run the MSTL-NNAR and STR-NBEATS models on your own data |
| `404.html` | Not-found page (uses absolute `/mohammed-elseidi-website/` paths because GitHub Pages serves it at any depth) |
| `dashboard.html` | UAQU OBEF results dashboard (standalone, its own styles) |

## Design system

| File | Contents |
|------|----------|
| `assets/site.css` | Shared foundation: `@font-face` rules, design tokens (colour, type, spacing, radii), base styles, navigation, buttons, badges, footer, scroll-reveal, reduced-motion and print rules |
| `assets/home.css` | Components used only on `index.html`: hero with the forecast-fan artwork, about, publications list, Lab feature band, career lists, awards, service blocks, talks & press, toolkit, contact, slides modal |
| `assets/lab.css` | Forecast Lab styles on top of `site.css`, including a CSS-mask icon shim for the `<i class="fas fa-…">` tags the Lab's JavaScript emits |
| `assets/fonts/` | Self-hosted latin subsets (woff2) of **Fraunces** (display), **Inter** (text) and **JetBrains Mono** (numbers, dates, labels), all from the Google Fonts catalogue |
| `assets/profile.jpg` | 400×400 portrait used in the hero; the home page falls back to a Google Drive copy, then to `favicon.svg`, if it fails to load |
| `assets/og-card.jpg` | 1200×630 link-preview card (Open Graph / Twitter `summary_large_image`) shown when a page is shared on LinkedIn, X or WhatsApp |
| `site.webmanifest` | Web app manifest so the site can be installed to a home screen; icons are `favicon.svg`, `apple-touch-icon.png` and `assets/icon-512.png` |

Conventions worth knowing before editing:

- Colours, type and spacing are CSS custom properties declared once in `assets/site.css`
  (`--ink`, `--paper`, `--teal`, `--font-display`, …). Change a token there and every page follows.
- Icons on the home page come from an inline SVG sprite at the top of `<body>` and are used as
  `<svg class="i"><use href="#i-name"/></svg>`. The Lab keeps Font Awesome class names for
  compatibility with `lab-ui.js`, but draws them from data-URI masks in `lab.css`.
- Every section keeps its historical anchor id (`#about`, `#publications`, `#experience`, `#qa`,
  `#education`, `#leadership`, `#editorial`, `#seminars`, `#media`, `#awards`, `#skills`, `#lab`,
  `#contact`), so old links still work.
- The YouTube recording is a click-to-load facade: the player is only embedded when a visitor
  presses play, which keeps the home page light.
- Seminar slide viewers appear automatically once a real link replaces the placeholder in the
  `slideLinks` object at the bottom of `index.html`.
- The site prints as a clean CV (`@media print` rules in `site.css` and `home.css`); the
  *Download CV (PDF)* button in the hero simply opens the print dialog.
- Publications carry topic filters, DOI links and a *Cite* dialog (APA and BibTeX with one-click
  copy). The citation data lives in the `PUBS` object at the bottom of `index.html`, and the five
  DOI-bearing papers are also described as `ScholarlyArticle` structured data in the `<head>`.
  "Try the model" links open the Forecast Lab with that framework preselected
  (`forecast-lab.html#model=mstl-nnar` or `#model=str-nbeats`).
- The Lab band ends with a "how the frameworks work" illustration drawn on three canvases from
  simulated data (observed series → trend / seasonal / remainder → forecast with intervals). It
  animates only while on screen and draws a static frame when the visitor prefers reduced motion.

## Forecast Lab

An interactive dashboard where a visitor uploads a time series and runs either of the two
published hybrid forecasting frameworks:

- **MSTL-NNAR** — Elseidi, M. (2024), *Stochastic Environmental Research and Risk
  Assessment*, 38(7), 2613–2632
- **STR-NBEATS** — Elseidi, M. (2025), *Modeling Earth Systems and Environment*, 11(4), 255

Everything runs in the visitor's browser. There is no server, so uploaded data never leaves
the device — which is also why the page can be hosted on GitHub Pages unchanged.

### Files

| File | Contents |
|------|----------|
| `assets/lab-core.js` | The numerical engine: LOESS, STL, MSTL, STR (penalised regression solved by preconditioned conjugate gradients), a small reverse-mode autodiff, NNAR, N-BEATS, accuracy measures and diagnostics |
| `assets/lab-worker.js` | Web Worker wrapper so training never blocks the page (falls back to the main thread if workers are unavailable) |
| `assets/lab-charts.js` | Canvas plotting — line charts with interval bands, crosshair tooltips, ACF bars |
| `assets/lab-ui.js` | File parsing, seasonality detection, run orchestration, results rendering |
| `assets/lab.css` | Styles, sharing the main site's design system |

No external JavaScript is required. SheetJS is fetched lazily only when someone drops in an
`.xlsx` file.

### What it does with a series

1. Parses the file — delimiter, header, date format and decimal convention are inferred.
2. Detects seasonal periods, accepting each on the strength that remains once the cycles
   already chosen are removed (so harmonics of a real cycle are not double-counted), against
   a bar that rises with the period's length.
3. Decomposes with MSTL or STR.
4. Fits NNAR or N-BEATS to the seasonally adjusted series and recombines with the
   extrapolated seasonal components.
5. Scores the result on a hold-out window against a seasonal-naive benchmark, then refits on
   the full series for the forecast the user takes away.

Output: point forecasts with prediction intervals, the decomposition, residual diagnostics
(ACF and Ljung-Box), accuracy tables and a CSV download.

The implementations use fixed, tested defaults rather than the hyper-parameter searches
behind the papers, so they will not reproduce the published figures exactly.

## Local preview

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. Serve over HTTP rather than opening the files directly —
the Forecast Lab's Web Worker needs a real origin (it falls back to the main thread otherwise).

To preview `404.html` exactly as GitHub Pages serves it (it uses absolute paths), run the
server from the parent directory and open
<http://localhost:8000/mohammed-elseidi-website/404.html>.
