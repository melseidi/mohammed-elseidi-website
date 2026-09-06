/*!
 * Forecast Lab UI — parsing, orchestration and rendering.
 * Everything here runs client side; no request ever carries the user's data.
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var fmt = window.LabCharts.fmtNum;

    var state = {
        raw: null,           // {columns:[{name, values, kind}], rowCount, source}
        dateCol: -1,
        valueCol: -1,
        series: null,        // Float64Array of values
        dates: null,         // array of Date or null
        freq: 'unknown',
        stepMs: null,
        periods: [],         // selected seasonal periods
        candidates: [],      // [{period, strength, label}]
        results: [],         // last run
        charts: [],
        running: false
    };

    /* ==========================================================
     * Parsing
     * ======================================================== */

    function detectDelimiter(text) {
        var sample = text.split(/\r?\n/).slice(0, 20).join('\n');
        var best = ',', bestScore = -1;
        [',', ';', '\t', '|'].forEach(function (d) {
            var counts = sample.split(/\r?\n/).filter(function (l) { return l.trim(); })
                .map(function (l) { return l.split(d).length; });
            if (!counts.length) return;
            var avg = counts.reduce(function (a, b) { return a + b; }, 0) / counts.length;
            if (avg < 2) return;
            var varc = counts.reduce(function (a, b) { return a + Math.pow(b - avg, 2); }, 0) / counts.length;
            var score = avg - varc * 3;               // prefer many, consistent columns
            if (score > bestScore) { bestScore = score; best = d; }
        });
        return best;
    }

    function splitLine(line, delim) {
        var out = [], cur = '', inQ = false;
        for (var i = 0; i < line.length; i++) {
            var c = line[i];
            if (inQ) {
                if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
                else cur += c;
            } else if (c === '"') inQ = true;
            else if (c === delim) { out.push(cur); cur = ''; }
            else cur += c;
        }
        out.push(cur);
        return out.map(function (s) { return s.trim(); });
    }

    var MISSING = ['', 'na', 'n/a', 'nan', 'null', 'nil', 'none', '-', '--', '.', '?'];

    function parseNumber(tok) {
        if (tok == null) return NaN;
        var s = String(tok).trim();
        if (MISSING.indexOf(s.toLowerCase()) >= 0) return NaN;
        s = s.replace(/[\s '%$£€]/g, '');
        var hasDot = s.indexOf('.') >= 0, hasComma = s.indexOf(',') >= 0;
        if (hasDot && hasComma) {
            // whichever separator comes last is the decimal point
            s = s.lastIndexOf(',') > s.lastIndexOf('.')
                ? s.replace(/\./g, '').replace(',', '.')
                : s.replace(/,/g, '');
        } else if (hasComma) {
            var parts = s.split(',');
            s = (parts.length === 2 && parts[1].length === 3 && parts[0].length > 0 && /^\d+$/.test(parts[1]))
                ? s.replace(/,/g, '')                 // 1,234 -> thousands
                : s.replace(',', '.');                // 12,5  -> decimal comma
        }
        var v = Number(s);
        return isFinite(v) ? v : NaN;
    }

    var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

    /** Decide one date format for a whole column, then apply it consistently. */
    function makeDateParser(samples) {
        var slashLike = 0, dayFirst = false, monthFirst = false;
        samples.forEach(function (s) {
            var m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(s);
            if (!m) return;
            slashLike++;
            if (+m[1] > 12) dayFirst = true;
            if (+m[2] > 12) monthFirst = true;
        });
        var preferDayFirst = dayFirst || !monthFirst;      // ISO-style ambiguity: assume D/M/Y

        return function (tok) {
            if (tok == null) return null;
            var s = String(tok).trim();
            if (!s) return null;
            var m;
            // ISO / SQL: 2024-05-03, 2024-05-03 14:30, 2024-05-03T14:30:00
            m = /^(\d{4})[-\/](\d{1,2})(?:[-\/](\d{1,2}))?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
            if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1,
                                            m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0));
            // D/M/Y or M/D/Y
            m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
            if (m) {
                var a = +m[1], b = +m[2], yr = +m[3];
                if (yr < 100) yr += yr < 70 ? 2000 : 1900;
                var day = preferDayFirst ? a : b, mon = preferDayFirst ? b : a;
                if (mon > 12) { var t = day; day = mon; mon = t; }
                return new Date(Date.UTC(yr, mon - 1, day, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0));
            }
            // 03 May 2024 / May 2024 / 2024 May
            m = /^(\d{1,2})?[\s-]*([A-Za-z]{3,})[\s-]+(\d{4})/.exec(s);
            if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] != null)
                return new Date(Date.UTC(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], m[1] ? +m[1] : 1));
            m = /^(\d{4})[\s-]+([A-Za-z]{3,})/.exec(s);
            if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] != null)
                return new Date(Date.UTC(+m[1], MONTHS[m[2].slice(0, 3).toLowerCase()], 1));
            // bare year
            if (/^(19|20)\d{2}$/.test(s)) return new Date(Date.UTC(+s, 0, 1));
            // Last resort: the engine's own parser is extremely lenient
            // ("UAQ-1" becomes 1 Jan 2001), so only trust it when the string
            // actually contains something that could be a year.
            if (!/\d{4}/.test(s)) return null;
            var d = new Date(s);
            if (!isFinite(d.getTime())) return null;
            var yr = d.getUTCFullYear();
            return yr >= 1000 && yr <= 3000 ? d : null;
        };
    }

    function classifyColumn(values) {
        var numeric = 0, dated = 0, filled = 0, distinct = {};
        var probe = values.slice(0, Math.min(200, values.length));
        var parser = makeDateParser(probe);
        probe.forEach(function (v) {
            var s = String(v == null ? '' : v).trim();
            if (!s || MISSING.indexOf(s.toLowerCase()) >= 0) return;
            filled++;
            if (isFinite(parseNumber(s))) numeric++;
            var d = parser(s);
            if (d && isFinite(d.getTime()) && !/^-?[\d.,]+$/.test(s)) { dated++; distinct[d.getTime()] = 1; }
        });
        if (!filled) return 'empty';
        // A timestamp column has to actually vary — a repeated label that happens
        // to parse as a date is not a time axis.
        if (dated / filled > 0.8 && Object.keys(distinct).length > Math.max(2, filled * 0.5)) return 'date';
        if (numeric / filled > 0.8) return 'numeric';
        return 'text';
    }

    function tableToColumns(rows, name) {
        // header row = the first row that is mostly non-numeric while the next is not
        var header = null, body = rows;
        if (rows.length > 1) {
            var first = rows[0], second = rows[1];
            var firstNum = first.filter(function (c) { return isFinite(parseNumber(c)); }).length;
            var secondNum = second.filter(function (c) { return isFinite(parseNumber(c)); }).length;
            if (firstNum < secondNum || (firstNum === 0 && first.some(function (c) { return String(c).trim(); }))) {
                header = first.map(function (c, i) { return String(c).trim() || 'Column ' + (i + 1); });
                body = rows.slice(1);
            }
        }
        var width = 0;
        rows.forEach(function (r) { width = Math.max(width, r.length); });
        if (!header) { header = []; for (var i = 0; i < width; i++) header.push('Column ' + (i + 1)); }
        var columns = [];
        for (var c = 0; c < width; c++) {
            var vals = body.map(function (r) { return r[c] == null ? '' : r[c]; });
            columns.push({ name: header[c] || 'Column ' + (c + 1), values: vals, kind: classifyColumn(vals) });
        }
        return { columns: columns, rowCount: body.length, source: name };
    }

    function parseDelimited(text, name) {
        var delim = detectDelimiter(text);
        var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
        if (!lines.length) throw new Error('That file appears to be empty.');
        if (lines.length > 60000) lines = lines.slice(0, 60000);
        var rows = lines.map(function (l) { return splitLine(l, delim); });
        return tableToColumns(rows, name);
    }

    /* ==========================================================
     * Frequency and future timestamps
     * ======================================================== */

    var HOUR = 3600e3, DAY = 24 * HOUR;

    function detectFrequency(dates) {
        if (!dates || dates.length < 3) return { freq: 'unknown', stepMs: null };
        var diffs = [];
        for (var i = 1; i < dates.length; i++) {
            var d = dates[i] - dates[i - 1];
            if (d > 0) diffs.push(d);
        }
        if (!diffs.length) return { freq: 'unknown', stepMs: null };
        diffs.sort(function (a, b) { return a - b; });
        var med = diffs[Math.floor(diffs.length / 2)];
        var freq = 'unknown';
        if (Math.abs(med - HOUR) < HOUR * 0.1) freq = 'hourly';
        else if (Math.abs(med - HOUR / 2) < HOUR * 0.1) freq = 'halfhourly';
        else if (Math.abs(med - 15 * 60e3) < 3 * 60e3) freq = 'quarterhourly';
        else if (Math.abs(med - DAY) < DAY * 0.15) freq = 'daily';
        else if (Math.abs(med - 7 * DAY) < DAY) freq = 'weekly';
        else if (med > 26 * DAY && med < 32 * DAY) freq = 'monthly';
        else if (med > 85 * DAY && med < 95 * DAY) freq = 'quarterly';
        else if (med > 350 * DAY && med < 380 * DAY) freq = 'yearly';
        else if (med < HOUR) freq = 'subhourly';
        return { freq: freq, stepMs: med };
    }

    function candidatePeriods(freq, n) {
        var base = {
            quarterhourly: [96, 672], halfhourly: [48, 336], hourly: [24, 168, 8766],
            daily: [7, 30, 365], weekly: [52], monthly: [12], quarterly: [4], yearly: [],
            subhourly: [], unknown: []
        }[freq] || [];
        return base.filter(function (p) { return p >= 2 && n >= 2 * p; });
    }

    function nextDates(last, count, freq, stepMs) {
        var out = [];
        for (var i = 1; i <= count; i++) {
            if (freq === 'monthly') {
                var d = new Date(last.getTime());
                d.setUTCMonth(d.getUTCMonth() + i);
                out.push(d);
            } else if (freq === 'quarterly') {
                var q = new Date(last.getTime());
                q.setUTCMonth(q.getUTCMonth() + 3 * i);
                out.push(q);
            } else if (freq === 'yearly') {
                var yv = new Date(last.getTime());
                yv.setUTCFullYear(yv.getUTCFullYear() + i);
                out.push(yv);
            } else {
                out.push(new Date(last.getTime() + stepMs * i));
            }
        }
        return out;
    }

    function labelFor(date, freq) {
        if (!date) return '';
        var o;
        if (freq === 'hourly' || freq === 'halfhourly' || freq === 'quarterhourly' || freq === 'subhourly')
            o = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' };
        else if (freq === 'monthly' || freq === 'quarterly') o = { year: 'numeric', month: 'short', timeZone: 'UTC' };
        else if (freq === 'yearly') o = { year: 'numeric', timeZone: 'UTC' };
        else o = { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' };
        return date.toLocaleDateString('en-GB', o);
    }

    function isoOf(date) {
        if (!date) return '';
        var s = date.toISOString();
        return s.indexOf('T00:00:00') > 0 ? s.slice(0, 10) : s.slice(0, 16).replace('T', ' ');
    }

    /* ==========================================================
     * Demo series
     * ======================================================== */

    function demoSeries(kind) {
        var rnd = mulberry(kind.length * 977 + 13), out = [], t, n, start, step, freq, name, unit;
        function g() { var u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
        var e = 0;
        if (kind === 'wind') {
            n = 24 * 60; step = HOUR; freq = 'hourly'; name = 'Wind speed'; unit = 'm/s';
            start = Date.UTC(2024, 0, 1);
            for (t = 0; t < n; t++) {
                e = 0.72 * e + g() * 0.55;
                var v = 7.4 + 1.6 * Math.sin(2 * Math.PI * t / 24 - 1.1) + 0.7 * Math.cos(4 * Math.PI * t / 24)
                      + 1.1 * Math.sin(2 * Math.PI * t / 168) + 1.4 * Math.sin(2 * Math.PI * t / (24 * 30)) + e;
                out.push(Math.max(0.2, v));
            }
        } else if (kind === 'temp') {
            n = 365 * 4; step = DAY; freq = 'daily'; name = 'Mean temperature'; unit = '°C';
            start = Date.UTC(2021, 0, 1);
            for (t = 0; t < n; t++) {
                e = 0.78 * e + g() * 1.25;
                out.push(21 + 11.5 * Math.sin(2 * Math.PI * (t - 110) / 365) + 0.6 * Math.sin(2 * Math.PI * t / 7)
                         + 0.0007 * t + e);
            }
        } else if (kind === 'monthly') {
            n = 180; step = null; freq = 'monthly'; name = 'Units sold'; unit = 'units';
            start = Date.UTC(2011, 0, 1);
            for (t = 0; t < n; t++) {
                e = 0.4 * e + g() * 0.035;
                var trend = 1200 * Math.exp(0.0042 * t);
                var seas = 1 + 0.22 * Math.sin(2 * Math.PI * (t - 2) / 12) + 0.09 * Math.cos(4 * Math.PI * t / 12);
                out.push(Math.round(trend * seas * (1 + e)));
            }
        } else {
            n = 48 * 40; step = HOUR / 2; freq = 'halfhourly'; name = 'System load'; unit = 'MW';
            start = Date.UTC(2024, 5, 1);
            for (t = 0; t < n; t++) {
                e = 0.8 * e + g() * 24;
                var tod = (t % 48) / 48;
                var daily = 420 * Math.sin(2 * Math.PI * (tod - 0.18)) + 180 * Math.sin(4 * Math.PI * (tod - 0.05));
                var dow = Math.floor(t / 48) % 7;
                var weekend = (dow === 5 || dow === 6) ? -260 : 0;
                out.push(Math.max(200, 3100 + daily + weekend + 140 * Math.sin(2 * Math.PI * t / (48 * 30)) + e));
            }
        }
        var dates = [];
        for (t = 0; t < n; t++) {
            if (freq === 'monthly') { var d = new Date(start); d.setUTCMonth(d.getUTCMonth() + t); dates.push(d); }
            else dates.push(new Date(start + step * t));
        }
        return { values: out, dates: dates, name: name + ' (' + unit + ')', freq: freq };
    }

    function mulberry(seed) {
        var a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /* ==========================================================
     * Compute engine — a Web Worker when available, otherwise the
     * main thread with cooperative yields so the page stays alive.
     * ======================================================== */

    var engine = (function () {
        var worker = null, fallback = null, seq = 0, pending = {};

        function makeWorker() {
            if (worker !== null) return worker;
            try {
                worker = new Worker('assets/lab-worker.js');
                worker.onmessage = function (e) {
                    var d = e.data, job = pending[d.id];
                    if (!job) return;
                    if (d.type === 'progress' && job.onProgress) job.onProgress(d.frac, d.label);
                    else if (d.type === 'result' || d.type === 'detected') { delete pending[d.id]; job.resolve(d.result); }
                    else if (d.type === 'error') { delete pending[d.id]; job.reject(new Error(d.message)); }
                };
                worker.onerror = function () { worker = false; };
            } catch (err) {
                worker = false;
            }
            return worker;
        }

        function loadCore() {
            if (fallback) return fallback;
            fallback = new Promise(function (resolve, reject) {
                if (window.LabCore) return resolve(window.LabCore);
                var s = document.createElement('script');
                s.src = 'assets/lab-core.js';
                s.onload = function () { resolve(window.LabCore); };
                s.onerror = function () { reject(new Error('Could not load the model engine (assets/lab-core.js).')); };
                document.head.appendChild(s);
            });
            return fallback;
        }

        function post(msg, onProgress) {
            var w = makeWorker();
            if (w) {
                var id = ++seq;
                msg.id = id;
                return new Promise(function (resolve, reject) {
                    pending[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
                    w.postMessage(msg);
                });
            }
            // main-thread fallback
            return loadCore().then(function (core) {
                var last = 0;
                var ctx = {
                    progress: function (frac, label) {
                        var now = Date.now();
                        if (now - last < 100 && frac < 1) return;
                        last = now;
                        if (onProgress) onProgress(frac, label);
                    },
                    yield: function () { return new Promise(function (r) { setTimeout(r, 0); }); }
                };
                if (msg.type === 'run') return core.runModel(msg.series, msg.cfg, ctx);
                return core.detectSeasonalPeriods(msg.series, msg.candidates);
            });
        }

        return {
            run: function (series, cfg, onProgress) { return post({ type: 'run', series: series, cfg: cfg }, onProgress); },
            detect: function (series, candidates, onProgress) { return post({ type: 'detect', series: series, candidates: candidates }, onProgress); },
            cancel: function () {
                if (worker) { worker.terminate(); worker = null; pending = {}; }
            },
            usingWorker: function () { return worker !== false; }
        };
    })();

    /* ==========================================================
     * Configuration
     * ======================================================== */

    var PRESETS = {
        fast:      { repeats: 3,  iters: 150, width: 32, layers: 2, blocksPerStack: 1, epochs: 60,  patience: 15, paths: 120 },
        balanced:  { repeats: 6,  iters: 250, width: 48, layers: 2, blocksPerStack: 1, epochs: 120, patience: 25, paths: 200 },
        thorough:  { repeats: 15, iters: 450, width: 64, layers: 3, blocksPerStack: 2, epochs: 250, patience: 45, paths: 400 }
    };

    function intOrNull(el) {
        var v = parseInt(el.value, 10);
        return isFinite(v) && v > 0 ? v : null;
    }

    function buildConfig(model) {
        var n = state.series.length;
        var preset = PRESETS[$('preset').value] || PRESETS.balanced;
        var periods = state.periods.slice().filter(function (p) { return n >= 2 * p; });
        var smallest = periods.length ? Math.min.apply(null, periods) : 0;

        var horizon = Math.max(1, Math.min(parseInt($('horizon').value, 10) || 1, Math.floor(n / 2)));
        var testSize = Math.max(0, Math.min(parseInt($('testSize').value, 10) || 0, Math.floor(n / 3)));

        // One full short cycle of lags works markedly better than half a cycle,
        // capped at 24 so the network stays quick to train.
        var p = intOrNull($('pLags'));
        if (!p) p = Math.max(4, Math.min(Math.max(smallest || 8, 8), 24, Math.floor(n / 8)));
        var hidden = intOrNull($('hidden'));
        var Praw = parseInt($('pSeas').value, 10);
        var P = periods.length ? (isFinite(Praw) ? Math.max(0, Praw) : 1) : 0;

        var cfg = {
            model: model,
            periods: periods,
            horizon: horizon,
            testSize: testSize,
            level: parseFloat($('level').value) || 0.95,
            seed: parseInt($('seed').value, 10) || 42,
            // MSTL-NNAR
            p: p,
            P: P,
            size: hidden || Math.max(2, Math.min(16, Math.ceil((p + P + 1) / 2))),
            repeats: intOrNull($('repeats')) || preset.repeats,
            iters: preset.iters,
            paths: preset.paths,
            // STR-NBEATS
            lookback: intOrNull($('lookback')) || 0,
            width: intOrNull($('width')) || preset.width,
            layers: preset.layers,
            blocksPerStack: preset.blocksPerStack,
            epochs: intOrNull($('epochs')) || preset.epochs,
            patience: preset.patience
        };
        if (!cfg.lookback) delete cfg.lookback;

        // keep big series responsive
        if (n > 6000) {
            cfg.repeats = Math.min(cfg.repeats, 4);
            cfg.iters = Math.min(cfg.iters, 200);
            cfg.epochs = Math.min(cfg.epochs, 60);
        }
        return cfg;
    }

    /* ==========================================================
     * Run
     * ======================================================== */

    function setProgress(frac, label) {
        $('progressFill').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
        $('progressLabel').textContent = label || '';
    }

    async function runForecast() {
        if (state.running || !state.series) return;
        var models = $('compareBoth').checked
            ? ['mstl-nnar', 'str-nbeats']
            : [document.querySelector('input[name="model"]:checked').value];

        var useLog = $('logTransform').checked;
        var fitSeries = Array.from(state.series);
        if (useLog) {
            var bad = fitSeries.filter(function (v) { return !(v > 0); }).length;
            if (bad) {
                showError('A log transform needs strictly positive values, but ' + bad +
                          ' observation' + (bad === 1 ? ' is' : 's are') + ' zero or negative. Uncheck it, or shift the series first.');
                return;
            }
            fitSeries = fitSeries.map(Math.log);
        }

        state.running = true;
        $('runBtn').disabled = true;
        $('progressWrap').hidden = false;
        setProgress(0, 'Preparing…');
        clearError();

        var results = [];
        try {
            for (var i = 0; i < models.length; i++) {
                var cfg = buildConfig(models[i]);
                if (cfg.testSize > 0 && cfg.testSize + 20 > state.series.length)
                    throw new Error('The hold-out is too large for a series of ' + state.series.length + ' points.');
                var label = models.length > 1 ? (i === 1 ? 'STR-NBEATS' : 'MSTL-NNAR') : null;
                var base = i / models.length, span = 1 / models.length;
                /* eslint-disable no-loop-func */
                var res = await engine.run(fitSeries, cfg, function (frac, msg) {
                    setProgress(base + span * frac, (label ? label + ' · ' : '') + (msg || ''));
                });
                /* eslint-enable no-loop-func */
                res.config = cfg;
                if (useLog) backTransform(res, cfg);
                results.push(res);
            }
            state.results = results;
            setProgress(1, 'Complete');
            renderResults();
        } catch (err) {
            showError(err.message || String(err));
        } finally {
            state.running = false;
            $('runBtn').disabled = false;
            setTimeout(function () { $('progressWrap').hidden = true; }, 600);
        }
    }

    /* ---- undoing a log transform ------------------------------
     * The models fit log(y); everything the user reads must be on the
     * original scale, and the accuracy measures have to be recomputed
     * there rather than converted.
     * --------------------------------------------------------- */

    function localMetrics(actual, pred, denom) {
        var n = 0, se = 0, ae = 0, ape = 0, sst = 0, i;
        var pairs = [];
        for (i = 0; i < actual.length; i++)
            if (isFinite(actual[i]) && isFinite(pred[i])) pairs.push([actual[i], pred[i]]);
        if (!pairs.length) return null;
        var mAct = pairs.reduce(function (a, b) { return a + b[0]; }, 0) / pairs.length;
        pairs.forEach(function (pr) {
            var e = pr[0] - pr[1];
            se += e * e; ae += Math.abs(e);
            if (Math.abs(pr[0]) > 1e-10) ape += Math.abs(e / pr[0]);
            sst += (pr[0] - mAct) * (pr[0] - mAct);
            n++;
        });
        return {
            n: n, rmse: Math.sqrt(se / n), mae: ae / n, mape: 100 * ape / n,
            r2: sst > 0 ? 1 - se / sst : NaN,
            mase: denom > 0 ? (ae / n) / denom : NaN
        };
    }

    function naiveScaleLocal(y, m) {
        m = Math.max(1, m || 1);
        var s = 0, c = 0;
        for (var i = m; i < y.length; i++) { s += Math.abs(y[i] - y[i - m]); c++; }
        return c ? s / c : 0;
    }

    function backTransform(r, cfg) {
        var expArr = function (a) { return a.map(function (v) { return isFinite(v) ? Math.exp(v) : NaN; }); };
        var orig = state.series;
        var mBase = 0;
        (cfg.periods || []).forEach(function (p) {
            if (orig.length >= 2 * p) mBase = mBase ? Math.min(mBase, p) : p;
        });
        if (!mBase) mBase = 1;

        r.point = expArr(r.point);
        if (r.intervals) { r.intervals.lower = expArr(r.intervals.lower); r.intervals.upper = expArr(r.intervals.upper); }
        r.fitted = expArr(r.fitted);
        r.residuals = r.fitted.map(function (f, i) { return isFinite(f) ? orig[i] - f : NaN; });
        var res = r.residuals.filter(isFinite);
        var mr = res.reduce(function (a, b) { return a + b; }, 0) / (res.length || 1);
        r.residualSd = Math.sqrt(res.reduce(function (a, b) { return a + (b - mr) * (b - mr); }, 0) / Math.max(1, res.length - 1));
        r.insample = localMetrics(orig, r.fitted, naiveScaleLocal(orig, mBase));

        if (r.evaluation) {
            var ev = r.evaluation;
            var train = orig.slice(0, ev.startIndex);
            var denom = naiveScaleLocal(train, mBase);
            ev.actual = expArr(ev.actual);
            ev.predicted = expArr(ev.predicted);
            ev.baseline.predicted = expArr(ev.baseline.predicted);
            ev.metrics = localMetrics(ev.actual, ev.predicted, denom);
            ev.baseline.metrics = localMetrics(ev.actual, ev.baseline.predicted, denom);
        }
        r.logScale = true;
        r.detail = Object.assign({ 'Transform': 'natural log (back-transformed for display)' }, r.detail);
    }

    function showError(msg) {
        var box = $('errorBox');
        if (!box) {
            box = document.createElement('div');
            box.id = 'errorBox';
            box.className = 'card';
            $('labMain').insertBefore(box, $('labMain').firstChild);
        }
        box.innerHTML = '<div class="alert alert-error"><i class="fas fa-triangle-exclamation"></i><div>' +
                        escapeHtml(msg) + '</div></div>';
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function clearError() { var b = $('errorBox'); if (b) b.remove(); }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /* ==========================================================
     * Rendering
     * ======================================================== */

    function el(html) {
        var d = document.createElement('div');
        d.innerHTML = html.trim();
        return d.firstChild;
    }

    function destroyCharts() {
        state.charts.forEach(function (c) { if (c && c.destroy) c.destroy(); });
        state.charts = [];
    }

    function chartCard(container, spec) {
        var wrap = container.querySelector('.chart-wrap') || container;
        var canvas = wrap.querySelector('canvas');
        var chart = window.LabCharts.lineChart(canvas, spec);
        state.charts.push(chart);
        return chart;
    }

    function legendHtml(items) {
        return '<div class="legend">' + items.map(function (it) {
            var key = it.band
                ? '<span class="legend-key band" style="background:' + it.color + '"></span>'
                : it.dashed
                    ? '<span class="legend-key dashed" style="color:' + it.color + '"></span>'
                    : '<span class="legend-key" style="background:' + it.color + '"></span>';
            return '<span class="legend-item">' + key + escapeHtml(it.name) + '</span>';
        }).join('') + '</div>';
    }

    function stride(arr, maxPoints) {
        if (arr.length <= maxPoints) return { values: arr, step: 1 };
        var step = Math.ceil(arr.length / maxPoints), out = [];
        for (var i = 0; i < arr.length; i += step) out.push(arr[i]);
        if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
        return { values: out, step: step };
    }

    function xLabels(from, to) {                    // inclusive history range
        var out = [];
        for (var i = from; i <= to; i++)
            out.push(state.dates ? labelFor(state.dates[i], state.freq) : 't = ' + (i + 1));
        return out;
    }

    function futureLabels(count) {
        if (!state.dates) {
            var out = [], n = state.series.length;
            for (var i = 1; i <= count; i++) out.push('t = ' + (n + i));
            return out;
        }
        return nextDates(state.dates[state.dates.length - 1], count, state.freq, state.stepMs)
            .map(function (d) { return labelFor(d, state.freq); });
    }

    function futureDates(count) {
        if (!state.dates) return null;
        return nextDates(state.dates[state.dates.length - 1], count, state.freq, state.stepMs);
    }

    /* ---- data preview ---------------------------------------- */

    function renderDataCard() {
        var host = $('labMain');
        var existing = $('dataCard');
        if (existing) existing.remove();
        var empty = $('emptyState');
        if (empty) empty.remove();

        var v = state.series, n = v.length;
        var finite = Array.prototype.filter.call(v, isFinite);
        var mean = finite.reduce(function (a, b) { return a + b; }, 0) / (finite.length || 1);
        var sdv = Math.sqrt(finite.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / Math.max(1, finite.length - 1));
        var missing = n - finite.length;
        var first = state.dates ? labelFor(state.dates[0], state.freq) : 't = 1';
        var last = state.dates ? labelFor(state.dates[n - 1], state.freq) : 't = ' + n;

        var card = el(
            '<section class="card" id="dataCard">' +
            '<div class="card-head"><h2><i class="fas fa-table-list" style="color:var(--primary)"></i> ' +
            escapeHtml(state.valueName || 'Series') + '</h2>' +
            '<span class="badge">' + n.toLocaleString() + ' observations · ' + state.freq + '</span></div>' +
            '<div class="stat-inline" style="margin-bottom:1rem;">' +
            '<div><span>From</span><strong>' + escapeHtml(first) + '</strong></div>' +
            '<div><span>To</span><strong>' + escapeHtml(last) + '</strong></div>' +
            '<div><span>Mean</span><strong>' + fmt(mean) + '</strong></div>' +
            '<div><span>Std. dev.</span><strong>' + fmt(sdv) + '</strong></div>' +
            '<div><span>Min</span><strong>' + fmt(Math.min.apply(null, finite)) + '</strong></div>' +
            '<div><span>Max</span><strong>' + fmt(Math.max.apply(null, finite)) + '</strong></div>' +
            '<div><span>Missing</span><strong>' + missing + '</strong></div>' +
            '</div>' +
            '<div class="chart-wrap"><canvas></canvas></div>' +
            (missing ? '<div class="alert alert-info" style="margin-top:0.9rem;"><i class="fas fa-circle-info"></i>' +
                       '<div>' + missing + ' missing value' + (missing === 1 ? '' : 's') +
                       ' will be filled by linear interpolation before fitting.</div></div>' : '') +
            '<p class="table-cap" id="detectNote"></p>' +
            '</section>');
        host.insertBefore(card, host.firstChild);

        var s = stride(Array.from(v), 2200);
        var labels = [];
        for (var i = 0; i < s.values.length; i++) {
            var idx = Math.min(n - 1, i * s.step);
            labels.push(state.dates ? labelFor(state.dates[idx], state.freq) : 't = ' + (idx + 1));
        }
        chartCard(card, {
            x: labels, height: 260,
            series: [{ name: state.valueName || 'Value', color: '#0f172a', data: s.values, width: 1.6 }]
        });
    }

    /* ---- results --------------------------------------------- */

    function renderResults() {
        destroyCharts();
        var host = $('labMain');
        Array.prototype.slice.call(host.querySelectorAll('.result-block')).forEach(function (n2) { n2.remove(); });
        var results = state.results;
        if (!results.length) return;

        var frag = document.createDocumentFragment();
        frag.appendChild(accuracyCard(results));
        frag.appendChild(forecastCard(results));
        if (results[0].evaluation) frag.appendChild(holdoutCard(results));
        results.forEach(function (r) {
            frag.appendChild(decompositionCard(r, results.length > 1));
            frag.appendChild(diagnosticsCard(r, results.length > 1));
        });
        frag.appendChild(tableCard(results));
        frag.appendChild(configCard(results));
        host.appendChild(frag);

        // charts are wired after the nodes are in the document so widths are real
        results.__mounted = true;
        mountCharts(results);
        host.querySelector('.result-block').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function colorOf(r, idx) {
        if (r.key === 'mstl-nnar') return '#0d9488';
        if (r.key === 'str-nbeats') return '#eb6834';
        return idx ? '#eb6834' : '#0d9488';
    }
    var BAND_OF = { 'mstl-nnar': 'rgba(13,148,136,0.15)', 'str-nbeats': 'rgba(235,104,52,0.15)' };
    var BASELINE_COLOR = '#2a78d6';
    var ACTUAL_COLOR = '#0f172a';

    function metricRow(m) {
        return m ? [fmt(m.rmse), fmt(m.mae), isFinite(m.mape) ? m.mape.toFixed(2) + '%' : '—',
                    isFinite(m.mase) ? m.mase.toFixed(3) : '—', isFinite(m.r2) ? m.r2.toFixed(3) : '—'] : ['—', '—', '—', '—', '—'];
    }

    function accuracyCard(results) {
        var ev = results[0].evaluation;
        var card = el('<section class="card result-block"><div class="card-head">' +
            '<h2><i class="fas fa-bullseye" style="color:var(--primary)"></i> Accuracy</h2>' +
            (ev ? '<span class="badge">hold-out of ' + ev.testSize + ' steps</span>'
                : '<span class="badge gray">no hold-out — evaluation skipped</span>') +
            '</div></section>');

        if (!ev) {
            card.appendChild(el('<div class="alert alert-info"><i class="fas fa-circle-info"></i><div>' +
                'The model was fitted on the whole series and no accuracy could be measured. ' +
                'Set a hold-out size above to score the forecast against data the model never saw.</div></div>'));
            var ins = el('<div class="kpi-grid" style="margin-top:1rem;"></div>');
            results.forEach(function (r) {
                ins.appendChild(el('<div class="kpi"><div class="label">' + escapeHtml(r.model) + ' · in-sample RMSE</div>' +
                    '<div class="value">' + fmt(r.insample ? r.insample.rmse : NaN) + '</div>' +
                    '<div class="foot">one-step-ahead fit, not a forecast test</div></div>'));
            });
            card.appendChild(ins);
            return card;
        }

        var best = results.reduce(function (a, b) {
            return (b.evaluation.metrics.rmse < a.evaluation.metrics.rmse) ? b : a;
        }, results[0]);
        var bm = best.evaluation.metrics, base = best.evaluation.baseline.metrics;
        var skill = 100 * (1 - bm.rmse / base.rmse);

        var kpis = el('<div class="kpi-grid"></div>');
        [['RMSE', fmt(bm.rmse), 'root mean squared error'],
         ['MAE', fmt(bm.mae), 'mean absolute error'],
         ['MAPE', isFinite(bm.mape) ? bm.mape.toFixed(2) + '%' : '—', 'mean absolute % error'],
         ['MASE', isFinite(bm.mase) ? bm.mase.toFixed(3) : '—', 'scaled by the in-sample naive error'],
         ['R²', isFinite(bm.r2) ? bm.r2.toFixed(3) : '—', 'variance explained on the hold-out']
        ].forEach(function (k) {
            kpis.appendChild(el('<div class="kpi"><div class="label">' + k[0] + '</div>' +
                '<div class="value">' + k[1] + '</div><div class="foot">' + k[2] + '</div></div>'));
        });
        kpis.appendChild(el('<div class="kpi"><div class="label">vs. benchmark</div>' +
            '<div class="value" style="color:' + (skill >= 0 ? 'var(--good)' : 'var(--bad)') + '">' +
            Math.abs(skill).toFixed(0) + '%</div>' +
            '<div class="foot ' + (skill >= 0 ? 'up' : 'down') + '">' +
            (skill >= 0 ? 'lower' : 'higher') + ' RMSE than ' +
            escapeHtml(best.evaluation.baseline.label.toLowerCase()) + '</div></div>'));
        card.appendChild(kpis);
        if (results.length > 1)
            card.appendChild(el('<p class="table-cap">Tiles show the better of the two models (' +
                escapeHtml(best.model) + '). Full comparison below.</p>'));

        // comparison table (always shown — it is also the accessible view of the charts)
        var rows = results.map(function (r) {
            var m = r.evaluation.metrics, cells = metricRow(m);
            return '<tr><td><span class="legend-key" style="display:inline-block;background:' + colorOf(r) +
                   ';margin-right:6px;"></span>' + escapeHtml(r.model) + '</td>' +
                   cells.map(function (c, i) {
                       var isBest = results.length > 1 && r === best && i < 2;
                       return '<td' + (isBest ? ' class="best"' : '') + '>' + c + '</td>';
                   }).join('') +
                   '<td>' + (r.elapsedMs / 1000).toFixed(1) + 's</td></tr>';
        }).join('');
        var bcells = metricRow(base);
        rows += '<tr><td><span class="legend-key" style="display:inline-block;background:' + BASELINE_COLOR +
                ';margin-right:6px;"></span>' + escapeHtml(results[0].evaluation.baseline.label) + '</td>' +
                bcells.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '<td>—</td></tr>';

        card.appendChild(el('<div class="table-scroll" style="margin-top:1.25rem;"><table class="data">' +
            '<thead><tr><th>Model</th><th>RMSE</th><th>MAE</th><th>MAPE</th><th>MASE</th><th>R²</th><th>Time</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table></div>'));
        card.appendChild(el('<p class="table-cap">Scored on the last ' + ev.testSize +
            ' observations, which were withheld from fitting. Lower is better for every measure except R². ' +
            'R² is measured against the variance of the hold-out window itself, so over a short or flat window ' +
            'it can be negative even when the forecast is close.</p>'));
        if (ev.testSize < 12)
            card.appendChild(el('<div class="alert alert-warn" style="margin-top:0.9rem;">' +
                '<i class="fas fa-triangle-exclamation"></i><div>A hold-out of only ' + ev.testSize +
                ' points makes these numbers noisy — a different split could reorder the models. ' +
                'Raise the hold-out size in step 3 for a firmer comparison.</div></div>'));
        return card;
    }

    function forecastCard(results) {
        var h = results[0].horizon;
        var n = state.series.length;
        var showHist = Math.min(n, Math.max(3 * h, 48));
        var from = n - showHist;
        var card = el('<section class="card result-block"><div class="card-head">' +
            '<h2><i class="fas fa-chart-line" style="color:var(--primary)"></i> Forecast</h2>' +
            '<div style="display:flex;gap:0.5rem;">' +
            '<button class="btn btn-ghost btn-sm" data-png="forecast"><i class="fas fa-image"></i> PNG</button>' +
            '<button class="btn btn-ghost btn-sm" data-csv="forecast"><i class="fas fa-download"></i> CSV</button>' +
            '</div></div>' +
            '<div class="chart-wrap" data-chart="forecast"><canvas></canvas></div>' +
            '<div data-legend="forecast"></div>' +
            '<p class="table-cap">Shaded bands are ' + Math.round((results[0].intervals ? results[0].intervals.level : 0.95) * 100) +
            '% prediction intervals. Hover the chart for values at any point.</p></section>');
        card.__spec = function () {
            var labels = xLabels(from, n - 1).concat(futureLabels(h));
            var total = labels.length;
            var actual = new Array(total).fill(null);
            for (var i = from; i < n; i++) actual[i - from] = state.series[i];
            var series = [{ name: 'Observed', color: ACTUAL_COLOR, data: actual, width: 1.8 }];
            var bands = [];
            results.forEach(function (r) {
                var f = new Array(total).fill(null);
                f[showHist - 1] = state.series[n - 1];               // join the history
                for (var k = 0; k < h; k++) f[showHist + k] = r.point[k];
                series.push({ name: r.model + ' forecast', color: colorOf(r), data: f, width: 2.4, dash: [6, 3] });
                if (r.intervals) {
                    var lo = new Array(total).fill(null), hi = new Array(total).fill(null);
                    lo[showHist - 1] = state.series[n - 1]; hi[showHist - 1] = state.series[n - 1];
                    for (var j = 0; j < h; j++) { lo[showHist + j] = r.intervals.lower[j]; hi[showHist + j] = r.intervals.upper[j]; }
                    bands.push({ name: r.model + ' interval', lower: lo, upper: hi, color: BAND_OF[r.key] || 'rgba(13,148,136,0.15)' });
                }
                if (results.length === 1 && r.fitted) {
                    var fit = new Array(total).fill(null);
                    for (var q = from; q < n; q++) if (isFinite(r.fitted[q])) fit[q - from] = r.fitted[q];
                    series.push({ name: 'Fitted (one step ahead)', color: colorOf(r), data: fit, width: 1.2, dash: [2, 3] });
                }
            });
            return { x: labels, series: series, bands: bands, height: 380,
                     marker: showHist - 1, markerLabel: 'forecast starts' };
        };
        return card;
    }

    function holdoutCard(results) {
        var ev = results[0].evaluation, t = ev.testSize;
        var card = el('<section class="card result-block"><div class="card-head">' +
            '<h2><i class="fas fa-vials" style="color:var(--primary)"></i> Hold-out check</h2>' +
            '<button class="btn btn-ghost btn-sm" data-png="holdout"><i class="fas fa-image"></i> PNG</button></div>' +
            '<p class="card-sub">What each model predicted for the ' + t +
            ' observations it was not allowed to see, against what actually happened.</p>' +
            '<div class="chart-wrap" data-chart="holdout"><canvas></canvas></div>' +
            '<div data-legend="holdout"></div></section>');
        card.__spec = function () {
            var start = ev.startIndex;
            var labels = xLabels(start, start + t - 1);
            var series = [{ name: 'Actual', color: ACTUAL_COLOR, data: ev.actual, width: 2.2 }];
            results.forEach(function (r) {
                series.push({ name: r.model, color: colorOf(r), data: r.evaluation.predicted, width: 2, dash: [6, 3] });
            });
            series.push({ name: ev.baseline.label, color: BASELINE_COLOR, data: ev.baseline.predicted, width: 1.4, dash: [2, 3] });
            return { x: labels, series: series, height: 300 };
        };
        return card;
    }

    function decompositionCard(r, multi) {
        var d = r.decomposition;
        var card = el('<section class="card result-block"><div class="card-head">' +
            '<h2><i class="fas fa-layer-group" style="color:var(--primary)"></i> Decomposition' +
            (multi ? ' — ' + escapeHtml(r.model) : '') + '</h2>' +
            '<span class="badge">' + (r.key === 'mstl-nnar' ? 'MSTL' : 'STR') + '</span></div>' +
            '<p class="card-sub">' + (r.key === 'mstl-nnar'
                ? 'MSTL peels off one seasonal pattern at a time with LOESS; the neural network is then fitted to what is left.'
                : 'STR estimates the trend and a slowly evolving seasonal profile jointly, as one penalised regression.') +
            (r.logScale ? ' Components are on the log scale, which is where the model was fitted.' : '') +
            '</p><div class="small-multiples" data-panels="1"></div></section>');
        var host = card.querySelector('.small-multiples');
        var panels = [{ title: 'Trend', data: d.trend, color: '#0d9488' }];
        d.seasonals.forEach(function (s, i) {
            panels.push({ title: 'Seasonal · period ' + d.periods[i], data: s, color: '#2a78d6' });
        });
        panels.push({ title: 'Remainder', data: d.remainder, color: '#eb6834',
                      note: 'sd ' + fmt(r.residualSd) });
        card.__panels = panels;
        panels.forEach(function (p) {
            host.appendChild(el('<div class="sm-panel"><h4>' + escapeHtml(p.title) +
                (p.note ? '<span class="sm-note">' + escapeHtml(p.note) + '</span>' : '') +
                '</h4><div class="chart-wrap"><canvas></canvas></div></div>'));
        });
        return card;
    }

    function diagnosticsCard(r, multi) {
        var lb = r.ljungBox;
        var verdict = lb
            ? (lb.pValue > 0.05
                ? '<span style="color:var(--good);font-weight:600;">no significant autocorrelation left</span> (p = ' + lb.pValue.toFixed(3) + ')'
                : '<span style="color:var(--bad);font-weight:600;">structure remains in the residuals</span> (p = ' + lb.pValue.toFixed(3) + ')')
            : 'not enough residuals to test';
        var card = el('<section class="card result-block"><div class="card-head">' +
            '<h2><i class="fas fa-stethoscope" style="color:var(--primary)"></i> Residual diagnostics' +
            (multi ? ' — ' + escapeHtml(r.model) : '') + '</h2></div>' +
            '<div class="chart-wrap" data-acf="1"><canvas></canvas></div>' +
            '<p class="table-cap">Autocorrelation of the one-step-ahead residuals' +
            (r.logScale ? ' (log scale)' : '') + '. Bars outside the grey band ' +
            'are significant at the 5% level. Ljung-Box: ' + verdict + '.' +
            (lb && lb.pValue <= 0.05 ? ' Try adding a seasonal period, or more lags.' : '') + '</p>' +
            '<div class="detail-grid" style="margin-top:1rem;">' +
            '<div><span class="k">Residual std. dev.</span><span class="v">' + fmt(r.residualSd) + '</span></div>' +
            '<div><span class="k">In-sample RMSE</span><span class="v">' + fmt(r.insample ? r.insample.rmse : NaN) + '</span></div>' +
            '<div><span class="k">In-sample MAE</span><span class="v">' + fmt(r.insample ? r.insample.mae : NaN) + '</span></div>' +
            '<div><span class="k">Training time</span><span class="v">' + (r.elapsedMs / 1000).toFixed(1) + ' s</span></div>' +
            '</div></section>');
        card.__acf = r.acf;
        card.__color = colorOf(r);
        return card;
    }

    function tableCard(results) {
        var h = results[0].horizon;
        var fd = futureDates(h);
        var head = '<th>Step</th><th>Time</th>';
        results.forEach(function (r) {
            head += '<th>' + escapeHtml(r.model) + '</th>';
            if (r.intervals) head += '<th>Lower</th><th>Upper</th>';
        });
        var body = '';
        for (var i = 0; i < h; i++) {
            body += '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(fd ? isoOf(fd[i]) : 't = ' + (state.series.length + i + 1)) + '</td>';
            results.forEach(function (r) {
                body += '<td>' + fmt(r.point[i]) + '</td>';
                if (r.intervals) body += '<td>' + fmt(r.intervals.lower[i]) + '</td><td>' + fmt(r.intervals.upper[i]) + '</td>';
            });
            body += '</tr>';
        }
        var card = el('<section class="card result-block"><div class="card-head">' +
            '<h2><i class="fas fa-list-ol" style="color:var(--primary)"></i> Forecast values</h2>' +
            '<button class="btn btn-primary btn-sm" data-csv="forecast"><i class="fas fa-download"></i> Download CSV</button></div>' +
            '<div class="table-scroll" style="max-height:420px;overflow-y:auto;"><table class="data">' +
            '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div></section>');
        return card;
    }

    function configCard(results) {
        var card = el('<section class="card result-block"><div class="card-head">' +
            '<h2><i class="fas fa-sliders" style="color:var(--primary)"></i> What was fitted</h2></div></section>');
        results.forEach(function (r) {
            var rows = Object.keys(r.detail).map(function (k) {
                return '<div><span class="k">' + escapeHtml(k) + '</span><span class="v">' + escapeHtml(String(r.detail[k])) + '</span></div>';
            }).join('');
            rows += '<div><span class="k">Forecast horizon</span><span class="v">' + r.horizon + '</span></div>';
            rows += '<div><span class="k">Random seed</span><span class="v">' + r.config.seed + '</span></div>';
            card.appendChild(el('<h3 style="font-size:0.95rem;margin:1rem 0 0.6rem;color:var(--dark);">' +
                '<span class="legend-key" style="display:inline-block;background:' + colorOf(r) + ';margin-right:6px;"></span>' +
                escapeHtml(r.model) + '</h3>'));
            card.appendChild(el('<div class="detail-grid">' + rows + '</div>'));
        });
        card.appendChild(el('<p class="table-cap" style="margin-top:1.25rem;">Runs are deterministic: the same data, ' +
            'settings and seed reproduce these numbers exactly.</p>'));
        return card;
    }

    function mountCharts(results) {
        var host = $('labMain');
        // forecast + hold-out
        Array.prototype.slice.call(host.querySelectorAll('.result-block')).forEach(function (card) {
            if (card.__spec) {
                var spec = card.__spec();
                var wrap = card.querySelector('.chart-wrap');
                state.charts.push(window.LabCharts.lineChart(wrap.querySelector('canvas'), spec));
                var legendHost = card.querySelector('[data-legend]');
                if (legendHost) {
                    var items = spec.series.map(function (s) {
                        return { name: s.name, color: s.color, dashed: !!s.dash };
                    }).concat((spec.bands || []).map(function (b) { return { name: b.name, color: b.color, band: true }; }));
                    legendHost.innerHTML = legendHtml(items);
                }
            }
            if (card.__panels) {
                var canvases = card.querySelectorAll('.sm-panel canvas');
                card.__panels.forEach(function (p, i) {
                    var s = stride(p.data, 1500);
                    var labels = [];
                    for (var k = 0; k < s.values.length; k++) {
                        var idx = Math.min(state.series.length - 1, k * s.step);
                        labels.push(state.dates ? labelFor(state.dates[idx], state.freq) : 't = ' + (idx + 1));
                    }
                    state.charts.push(window.LabCharts.lineChart(canvases[i], {
                        x: labels, height: 170,
                        series: [{ name: p.title, color: p.color, data: s.values, width: 1.5 }]
                    }));
                });
            }
            if (card.__acf) {
                state.charts.push(window.LabCharts.acfChart(
                    card.querySelector('[data-acf] canvas'), card.__acf.values, card.__acf.bound, card.__color));
            }
        });
    }

    /* ==========================================================
     * Downloads
     * ======================================================== */

    function saveBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function downloadForecastCsv() {
        var results = state.results;
        if (!results.length) return;
        var h = results[0].horizon, fd = futureDates(h);
        var head = ['step', 'time'];
        results.forEach(function (r) {
            var tag = r.key;
            head.push(tag + '_forecast');
            if (r.intervals) head.push(tag + '_lower', tag + '_upper');
        });
        var lines = [head.join(',')];
        for (var i = 0; i < h; i++) {
            var row = [i + 1, fd ? isoOf(fd[i]) : (state.series.length + i + 1)];
            results.forEach(function (r) {
                row.push(r.point[i].toFixed(6));
                if (r.intervals) row.push(r.intervals.lower[i].toFixed(6), r.intervals.upper[i].toFixed(6));
            });
            lines.push(row.join(','));
        }
        var meta = ['# Forecast Lab — ' + results.map(function (r) { return r.model; }).join(' + '),
                    '# generated ' + new Date().toISOString(),
                    '# seasonal periods: ' + (results[0].periods.length ? results[0].periods.join(' ') : 'none'),
                    '# interval level: ' + (results[0].intervals ? results[0].intervals.level : 'n/a')];
        saveBlob(new Blob([meta.concat(lines).join('\n')], { type: 'text/csv;charset=utf-8' }),
                 'forecast-' + new Date().toISOString().slice(0, 10) + '.csv');
    }

    function downloadPng(card, name) {
        var canvas = card.querySelector('canvas');
        if (!canvas) return;
        var out = document.createElement('canvas');
        out.width = canvas.width; out.height = canvas.height;
        var ctx = out.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(canvas, 0, 0);
        out.toBlob(function (blob) { saveBlob(blob, name + '.png'); });
    }

    /* ==========================================================
     * Loading data
     * ======================================================== */

    function loadTable(table) {
        if (!table.columns.length || !table.rowCount)
            throw new Error('No rows could be read from that file.');
        state.raw = table;

        var dateSel = $('colDate'), valSel = $('colValue');
        dateSel.innerHTML = '<option value="-1">Row number (no dates)</option>';
        valSel.innerHTML = '';
        table.columns.forEach(function (c, i) {
            dateSel.appendChild(el('<option value="' + i + '">' + escapeHtml(c.name) + '</option>'));
            valSel.appendChild(el('<option value="' + i + '">' + escapeHtml(c.name) + '</option>'));
        });

        var dateIdx = -1, valIdx = -1, i;
        for (i = 0; i < table.columns.length; i++)
            if (table.columns[i].kind === 'date') { dateIdx = i; break; }
        for (i = 0; i < table.columns.length; i++)
            if (i !== dateIdx && table.columns[i].kind === 'numeric') { valIdx = i; break; }
        if (valIdx < 0) {
            for (i = 0; i < table.columns.length; i++) if (i !== dateIdx) { valIdx = i; break; }
        }
        if (valIdx < 0) throw new Error('No numeric column was found in that file.');

        dateSel.value = String(dateIdx);
        valSel.value = String(valIdx);
        $('columnPicker').hidden = false;
        $('fileNote').textContent = table.source + ' · ' + table.rowCount.toLocaleString() + ' rows · ' +
                                    table.columns.length + ' columns';
        applyColumns();
    }

    function applyColumns() {
        clearError();
        var table = state.raw;
        if (!table) return;
        var di = parseInt($('colDate').value, 10);
        var vi = parseInt($('colValue').value, 10);
        var valueCol = table.columns[vi];
        if (!valueCol) return;

        var values = valueCol.values.map(parseNumber);
        var dates = null;
        if (di >= 0) {
            var col = table.columns[di];
            var parser = makeDateParser(col.values.slice(0, 200));
            dates = col.values.map(function (v) {
                if (col.kind === 'numeric' && table.excelDates) {
                    var num = parseNumber(v);
                    return isFinite(num) ? new Date(Date.UTC(1899, 11, 30) + num * DAY) : null;
                }
                return parser(v);
            });
        }

        // drop rows with no usable value, and (if dated) no usable date
        var pairs = [];
        for (var i = 0; i < values.length; i++) {
            if (dates && (!dates[i] || !isFinite(dates[i].getTime()))) continue;
            if (!isFinite(values[i]) && !dates) continue;
            pairs.push({ t: dates ? dates[i].getTime() : i, v: values[i], d: dates ? dates[i] : null });
        }
        if (pairs.length < 12) throw new Error('Only ' + pairs.length + ' usable observations were found — at least 12 are needed.');
        if (dates) pairs.sort(function (a, b) { return a.t - b.t; });

        state.series = pairs.map(function (p) { return p.v; });
        state.dates = dates ? pairs.map(function (p) { return p.d; }) : null;
        state.valueName = valueCol.name;

        var f = state.dates ? detectFrequency(state.dates.map(function (d) { return d.getTime(); }))
                            : { freq: 'unknown', stepMs: null };
        state.freq = f.freq;
        state.stepMs = f.stepMs;

        renderDataCard();
        detectSeasonality();
        $('runBtn').disabled = false;
    }

    function detectSeasonality() {
        var n = state.series.length;
        var cands = candidatePeriods(state.freq, n);
        if (!cands.length) cands = [4, 7, 12, 24, 52].filter(function (p) { return n >= 2 * p; });
        if (!cands.length) {
            state.candidates = [];
            state.periods = [];
            renderChips();
            setDefaults();
            return;
        }
        var note = $('detectNote');
        if (note) note.textContent = 'Testing candidate seasonal periods…';
        $('periodChips').innerHTML = '<span class="hint">Detecting seasonality…</span>';

        engine.detect(Array.from(state.series), cands).then(function (found) {
            state.candidates = found.candidates.sort(function (a, b) { return b.strength - a.strength; });
            state.periods = found.selected.slice();
            renderChips();
            setDefaults();
            if (note) {
                note.textContent = state.periods.length
                    ? 'Modelling seasonality at period ' + state.periods.join(' and ') +
                      '. Adjust the selection in step 3 if that is not right.'
                    : 'No strong seasonality detected — the models will fit the trend and the remaining dynamics.';
            }
        }).catch(function (err) {
            $('periodChips').innerHTML = '<span class="hint">Detection failed: ' + escapeHtml(err.message) + '</span>';
        });
    }

    function renderChips() {
        var host = $('periodChips');
        host.innerHTML = '';
        var shown = {};
        state.candidates.forEach(function (c) {
            shown[c.period] = true;
            var on = state.periods.indexOf(c.period) >= 0;
            var chip = el('<button type="button" class="chip" aria-pressed="' + on + '" data-period="' + c.period + '">' +
                c.period + '<span class="strength">' + Math.round(c.strength * 100) + '%</span></button>');
            chip.title = 'Seasonal strength at period ' + c.period + ': ' + (c.strength * 100).toFixed(0) + '%';
            host.appendChild(chip);
        });
        state.periods.forEach(function (p) {
            if (shown[p]) return;
            host.appendChild(el('<button type="button" class="chip" aria-pressed="true" data-period="' + p + '">' +
                p + '<span class="rm">×</span></button>'));
        });
        if (!host.children.length) host.innerHTML = '<span class="hint">No seasonal periods — add one manually if you know it.</span>';
    }

    function setDefaults() {
        var n = state.series.length;
        var smallest = state.periods.length ? Math.min.apply(null, state.periods) : 0;
        var base = smallest || ({ hourly: 24, halfhourly: 48, daily: 14, weekly: 8, monthly: 12, quarterly: 4 }[state.freq] || 12);
        // Forecast whole seasonal cycles, but never so few points that the
        // hold-out score is decided by luck: a 7-day window is too short to
        // separate two models.
        var suggestion = base * Math.max(1, Math.ceil(12 / base));
        suggestion = Math.max(1, Math.min(suggestion, Math.floor(n / 4)));
        $('horizon').value = suggestion;
        $('testSize').value = Math.max(1, Math.min(suggestion, Math.floor(n / 5)));
    }

    /* ==========================================================
     * File handling
     * ======================================================== */

    function readFile(file) {
        clearError();
        var name = (file.name || '').toLowerCase();
        if (/\.xlsx?$/.test(name)) return readExcel(file);
        var reader = new FileReader();
        reader.onload = function () {
            try { loadTable(parseDelimited(String(reader.result), file.name)); }
            catch (err) { showError(err.message); }
        };
        reader.onerror = function () { showError('That file could not be read.'); };
        reader.readAsText(file);
    }

    function readExcel(file) {
        loadSheetJs().then(function (XLSX) {
            var reader = new FileReader();
            reader.onload = function () {
                try {
                    var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array', cellDates: true });
                    var sheet = wb.Sheets[wb.SheetNames[0]];
                    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, dateNF: 'yyyy-mm-dd hh:mm:ss' });
                    rows = rows.filter(function (r) { return r && r.some(function (c) { return String(c == null ? '' : c).trim(); }); });
                    if (!rows.length) throw new Error('The first sheet is empty.');
                    loadTable(tableToColumns(rows.map(function (r) {
                        return r.map(function (c) { return c == null ? '' : String(c); });
                    }), file.name + ' · ' + wb.SheetNames[0]));
                } catch (err) { showError(err.message); }
            };
            reader.readAsArrayBuffer(file);
        }).catch(function () {
            showError('Excel support needs an internet connection. Save the sheet as CSV and upload that instead.');
        });
    }

    var sheetJsPromise = null;
    function loadSheetJs() {
        if (sheetJsPromise) return sheetJsPromise;
        sheetJsPromise = new Promise(function (resolve, reject) {
            if (window.XLSX) return resolve(window.XLSX);
            var s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
            s.onload = function () { window.XLSX ? resolve(window.XLSX) : reject(new Error('load failed')); };
            s.onerror = function () { reject(new Error('load failed')); };
            document.head.appendChild(s);
        });
        return sheetJsPromise;
    }

    /* ==========================================================
     * Wiring
     * ======================================================== */

    function selectTab(which) {
        [['tabUpload', 'paneUpload'], ['tabPaste', 'panePaste'], ['tabDemo', 'paneDemo']].forEach(function (pair) {
            var on = pair[0] === which;
            $(pair[0]).setAttribute('aria-selected', String(on));
            $(pair[1]).hidden = !on;
        });
    }

    function init() {
        // nav
        var toggle = $('navToggle');
        if (toggle) toggle.addEventListener('click', function () {
            var links = $('navLinks');
            links.classList.toggle('active');
            toggle.setAttribute('aria-expanded', String(links.classList.contains('active')));
        });

        ['tabUpload', 'tabPaste', 'tabDemo'].forEach(function (id) {
            $(id).addEventListener('click', function () { selectTab(id); });
        });

        // file input + drop zone
        var dz = $('dropzone'), fi = $('fileInput');
        dz.addEventListener('click', function () { fi.click(); });
        dz.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
        });
        fi.addEventListener('change', function () { if (fi.files[0]) readFile(fi.files[0]); });
        ['dragenter', 'dragover'].forEach(function (ev) {
            dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
        });
        ['dragleave', 'drop'].forEach(function (ev) {
            dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
        });
        dz.addEventListener('drop', function (e) {
            if (e.dataTransfer && e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
        });

        $('pasteLoad').addEventListener('click', function () {
            try {
                var text = $('pasteArea').value;
                if (!text.trim()) throw new Error('Paste some data first.');
                loadTable(parseDelimited(text, 'Pasted data'));
            } catch (err) { showError(err.message); }
        });

        Array.prototype.slice.call(document.querySelectorAll('[data-demo]')).forEach(function (btn) {
            btn.addEventListener('click', function () {
                try {
                    var d = demoSeries(btn.getAttribute('data-demo'));
                    state.raw = null;
                    $('columnPicker').hidden = true;
                    state.series = d.values;
                    state.dates = d.dates;
                    state.valueName = d.name;
                    var f = detectFrequency(d.dates.map(function (x) { return x.getTime(); }));
                    state.freq = f.freq; state.stepMs = f.stepMs;
                    clearError();
                    renderDataCard();
                    detectSeasonality();
                    $('runBtn').disabled = false;
                } catch (err) { showError(err.message); }
            });
        });

        $('colDate').addEventListener('change', function () { try { applyColumns(); } catch (e) { showError(e.message); } });
        $('colValue').addEventListener('change', function () { try { applyColumns(); } catch (e) { showError(e.message); } });

        $('periodChips').addEventListener('click', function (e) {
            var chip = e.target.closest ? e.target.closest('.chip') : null;
            if (!chip) return;
            var p = parseInt(chip.getAttribute('data-period'), 10);
            var at = state.periods.indexOf(p);
            if (at >= 0) state.periods.splice(at, 1); else state.periods.push(p);
            state.periods.sort(function (a, b) { return a - b; });
            renderChips();
            setDefaults();
        });

        $('addPeriod').addEventListener('click', function () {
            var v = parseInt($('customPeriod').value, 10);
            if (!isFinite(v) || v < 2) return;
            if (state.series && state.series.length < 2 * v) {
                showError('A period of ' + v + ' needs at least ' + (2 * v) + ' observations; the series has ' + state.series.length + '.');
                return;
            }
            if (state.periods.indexOf(v) < 0) state.periods.push(v);
            state.periods.sort(function (a, b) { return a - b; });
            $('customPeriod').value = '';
            renderChips();
        });

        $('runBtn').addEventListener('click', runForecast);
        $('cancelBtn').addEventListener('click', function () {
            engine.cancel();
            state.running = false;
            $('runBtn').disabled = false;
            $('progressWrap').hidden = true;
        });

        // delegated export buttons
        $('labMain').addEventListener('click', function (e) {
            var t = e.target.closest ? e.target.closest('[data-csv],[data-png]') : null;
            if (!t) return;
            if (t.hasAttribute('data-csv')) downloadForecastCsv();
            else downloadPng(t.closest('.result-block'), 'forecast-lab-' + t.getAttribute('data-png'));
        });

        // A link such as forecast-lab.html#model=str-nbeats preselects that framework
        var pre = /model=(mstl-nnar|str-nbeats)/.exec(location.hash + location.search);
        if (pre) {
            var radio = document.querySelector('input[name="model"][value="' + pre[1] + '"]');
            if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
        }

        selectTab('tabUpload');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
