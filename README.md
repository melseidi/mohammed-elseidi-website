# mohammed-elseidi-website

Personal academic website of Dr. Mohammed Elseidi — Associate Professor of Statistics &
Data Science and Director of Quality Assurance, Umm Al Quwain University.

A static site, served straight from this repository. No build step and no backend.

## Pages

| File | What it is |
|------|------------|
| `index.html` | The main CV site — biography, experience, publications, seminars, awards |
| `forecast-lab.html` | **Forecast Lab** — run the MSTL-NNAR and STR-NBEATS models on your own data |
| `dashboard.html` | UAQU OBEF results dashboard (standalone) |

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
| `assets/lab.css` | Styles, sharing the main site's palette |

No external JavaScript is required. Font Awesome is loaded from a CDN for icons, and SheetJS
is fetched lazily only when someone drops in an `.xlsx` file.

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
