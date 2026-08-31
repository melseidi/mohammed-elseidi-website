/*!
 * Forecast Lab Core — numerical engine
 * Dr. Mohammed Elseidi · https://github.com/melseidi/mohammed-elseidi-website
 *
 * Pure-JavaScript implementations of the two hybrid forecasting frameworks:
 *   MSTL-NNAR   Elseidi (2024) Stoch Environ Res Risk Assess 38(7), 2613-2632
 *   STR-NBEATS  Elseidi (2025) Model Earth Syst Environ 11(4), 255
 *
 * Everything runs client side: no data ever leaves the browser.
 * Works both as a browser global (window.LabCore) and inside a Web Worker
 * (importScripts) or Node (module.exports) for testing.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.LabCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* ============================================================
     * 1. Small numeric helpers
     * ========================================================== */

    /** Deterministic PRNG so every run of the same configuration reproduces. */
    function mulberry32(seed) {
        var a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** Standard normal via Box-Muller, driven by a supplied uniform RNG. */
    function gaussian(rng) {
        var u = 0, v = 0;
        while (u === 0) u = rng();
        while (v === 0) v = rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    function mean(a) {
        var s = 0, n = 0;
        for (var i = 0; i < a.length; i++) if (isFinite(a[i])) { s += a[i]; n++; }
        return n ? s / n : 0;
    }

    function sd(a) {
        var m = mean(a), s = 0, n = 0;
        for (var i = 0; i < a.length; i++) if (isFinite(a[i])) { s += (a[i] - m) * (a[i] - m); n++; }
        return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
    }

    function quantile(sorted, p) {
        if (!sorted.length) return NaN;
        var idx = (sorted.length - 1) * p;
        var lo = Math.floor(idx), hi = Math.ceil(idx);
        if (lo === hi) return sorted[lo];
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    }

    function zeros(n) { return new Float64Array(n); }

    function nextOdd(x) {
        var v = Math.round(x);
        return v % 2 === 0 ? v + 1 : v;
    }

    /** Linear interpolation over the missing entries of a series (NaN-safe). */
    function interpolateGaps(y) {
        var out = Float64Array.from(y), n = out.length, i, j;
        var first = -1, last = -1;
        for (i = 0; i < n; i++) if (isFinite(out[i])) { if (first < 0) first = i; last = i; }
        if (first < 0) throw new Error('Series contains no numeric values.');
        for (i = 0; i < first; i++) out[i] = out[first];
        for (i = last + 1; i < n; i++) out[i] = out[last];
        i = first;
        while (i <= last) {
            if (isFinite(out[i])) { i++; continue; }
            j = i;
            while (j <= last && !isFinite(out[j])) j++;
            var a = out[i - 1], b = out[j], span = j - (i - 1);
            for (var k = i; k < j; k++) out[k] = a + (b - a) * (k - (i - 1)) / span;
            i = j;
        }
        return out;
    }

    /* ============================================================
     * 2. LOESS — locally weighted linear regression on an evenly
     *    spaced grid. This is the smoother STL is built from.
     * ========================================================== */

    /**
     * @param {Float64Array} y      series
     * @param {number} q            window width in points (odd, >= 2)
     * @param {number} degree       1 = local linear, 0 = local constant
     * @param {number} jump         evaluate every `jump`-th point, interpolate between
     */
    function loess(y, q, degree, jump) {
        var n = y.length;
        degree = degree == null ? 1 : degree;
        q = Math.max(2, Math.round(q));
        jump = Math.max(1, Math.round(jump || 1));
        if (q >= n * 10) q = n * 10;

        var out = zeros(n);
        var points = [];
        for (var i = 0; i < n; i += jump) points.push(i);
        if (points[points.length - 1] !== n - 1) points.push(n - 1);

        for (var pi = 0; pi < points.length; pi++) {
            out[points[pi]] = loessPoint(y, points[pi], q, degree);
        }
        // Fill the skipped positions by linear interpolation.
        for (var s = 0; s < points.length - 1; s++) {
            var a = points[s], b = points[s + 1];
            if (b - a < 2) continue;
            var ya = out[a], yb = out[b];
            for (var t = a + 1; t < b; t++) out[t] = ya + (yb - ya) * (t - a) / (b - a);
        }
        return out;
    }

    function loessPoint(y, at, q, degree) {
        var n = y.length, lo, hi;
        if (q >= n) { lo = 0; hi = n - 1; }
        else {
            lo = at - ((q - 1) >> 1);
            hi = lo + q - 1;
            if (lo < 0) { lo = 0; hi = q - 1; }
            if (hi > n - 1) { hi = n - 1; lo = n - q; }
        }
        // Bandwidth: STL widens lambda when the window exceeds the series.
        var lambda = Math.max(at - lo, hi - at);
        if (q > n) lambda += (q - n) / 2;
        if (lambda <= 0) lambda = 1;

        var sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
        for (var j = lo; j <= hi; j++) {
            var r = Math.abs(j - at) / lambda;
            if (r >= 1) continue;
            var u = 1 - r * r * r;
            var w = u * u * u;                    // tricube
            var x = j - at;
            sw += w; swx += w * x; swy += w * y[j];
            swxx += w * x * x; swxy += w * x * y[j];
        }
        if (sw <= 0) return y[at];
        if (degree === 0) return swy / sw;
        var det = sw * swxx - swx * swx;
        if (Math.abs(det) < 1e-12 * (sw * swxx + 1)) return swy / sw;
        // Intercept of the weighted line, evaluated at x = 0 (i.e. at `at`).
        return (swxx * swy - swx * swxy) / det;
    }

    /** Centred/simple moving average of the given order; output is shorter. */
    function movingAverage(a, order) {
        var n = a.length, m = n - order + 1;
        if (m <= 0) return Float64Array.from(a);
        var out = zeros(m), s = 0, i;
        for (i = 0; i < order; i++) s += a[i];
        out[0] = s / order;
        for (i = order; i < n; i++) {
            s += a[i] - a[i - order];
            out[i - order + 1] = s / order;
        }
        return out;
    }

    /* ============================================================
     * 3. STL (seasonal-trend decomposition by LOESS), periodic
     *    seasonality — the building block MSTL iterates over.
     * ========================================================== */

    function stl(y, period, opts) {
        opts = opts || {};
        var n = y.length, m = period, i, j;
        var inner = opts.inner || 2;
        var tWindow = opts.tWindow || nextOdd(Math.ceil(1.5 * m));
        var lWindow = opts.lWindow || nextOdd(m);
        var jump = Math.max(1, Math.ceil(m / 10));
        var cycles = n / m;
        var phaseWindow = opts.phaseWindow != null ? opts.phaseWindow
            : (m >= 60 && cycles < 12 ? nextOdd(Math.max(3, Math.round(m / 24))) : 1);

        var trend = zeros(n), seasonal = zeros(n);

        for (var it = 0; it < inner; it++) {
            // (1) detrend
            var detr = zeros(n);
            for (i = 0; i < n; i++) detr[i] = y[i] - trend[i];

            // (2) cycle-subseries smoothing. s.window = "periodic" means each
            //     phase is smoothed to its own mean.
            var phaseMean = new Float64Array(m), phaseCount = new Float64Array(m);
            for (i = 0; i < n; i++) { phaseMean[i % m] += detr[i]; phaseCount[i % m]++; }
            for (j = 0; j < m; j++) phaseMean[j] = phaseCount[j] ? phaseMean[j] / phaseCount[j] : 0;

            // For a long period there are only a handful of observations per
            // phase, so the raw phase means are noisy. Neighbouring phases of a
            // yearly or weekly-of-hour cycle are near-identical, so smooth the
            // profile circularly before it becomes the seasonal component.
            if (phaseWindow > 1) phaseMean = circularSmooth(phaseMean, phaseWindow);

            // extended cycle-subseries: one period of padding on each side
            var ext = zeros(n + 2 * m);
            for (i = 0; i < n + 2 * m; i++) ext[i] = phaseMean[i % m];

            // (3) low-pass filter: MA(m), MA(m), MA(3), then LOESS
            var lp = movingAverage(movingAverage(movingAverage(ext, m), m), 3);
            lp = loess(lp, lWindow, 1, 1);

            // (4) seasonal = extended subseries minus low-pass
            for (i = 0; i < n; i++) seasonal[i] = ext[i + m] - lp[i];

            // (5) deseasonalise and (6) re-estimate the trend
            var deseas = zeros(n);
            for (i = 0; i < n; i++) deseas[i] = y[i] - seasonal[i];
            trend = loess(deseas, tWindow, 1, jump);
        }

        var remainder = zeros(n);
        for (i = 0; i < n; i++) remainder[i] = y[i] - trend[i] - seasonal[i];
        return { trend: trend, seasonal: seasonal, remainder: remainder, period: m };
    }

    /** Moving average around a cycle, wrapping at the ends. */
    function circularSmooth(profile, window) {
        var m = profile.length, out = zeros(m), half = (window - 1) >> 1;
        for (var j = 0; j < m; j++) {
            var s = 0, c = 0;
            for (var d = -half; d <= half; d++) { s += profile[((j + d) % m + m) % m]; c++; }
            out[j] = s / c;
        }
        return out;
    }

    /* ============================================================
     * 4. MSTL — multiple seasonal-trend decomposition.
     *    Bandara, Hyndman & Bergmeir (2021); the front half of
     *    the MSTL-NNAR framework.
     * ========================================================== */

    function mstl(y, periods, opts) {
        opts = opts || {};
        var n = y.length, i, k;
        var iterate = opts.iterate == null ? 2 : opts.iterate;

        var valid = (periods || [])
            .map(function (p) { return Math.round(p); })
            .filter(function (p) { return p >= 2 && n >= 2 * p; })
            .sort(function (a, b) { return a - b; })
            .filter(function (p, idx, arr) { return idx === 0 || p !== arr[idx - 1]; });

        var seasonals = valid.map(function () { return zeros(n); });
        var deseas = Float64Array.from(y);
        var trend = zeros(n), remainder = zeros(n);

        if (!valid.length) {
            trend = loess(deseas, nextOdd(Math.max(7, Math.round(n / 4))), 1, Math.max(1, Math.ceil(n / 100)));
            for (i = 0; i < n; i++) remainder[i] = y[i] - trend[i];
            return { trend: trend, seasonals: [], periods: [], remainder: remainder,
                     seasonAdjusted: Float64Array.from(y), seasonalTotal: zeros(n) };
        }

        var reps = valid.length === 1 ? 1 : iterate;
        var fit = null;
        for (var r = 0; r < reps; r++) {
            for (k = 0; k < valid.length; k++) {
                for (i = 0; i < n; i++) deseas[i] += seasonals[k][i];   // add this component back
                fit = stl(deseas, valid[k], opts);
                seasonals[k] = fit.seasonal;
                for (i = 0; i < n; i++) deseas[i] -= seasonals[k][i];   // and take the new estimate out
            }
        }
        trend = fit.trend;
        var seasonalTotal = zeros(n);
        for (k = 0; k < seasonals.length; k++)
            for (i = 0; i < n; i++) seasonalTotal[i] += seasonals[k][i];
        var seasonAdjusted = zeros(n);
        for (i = 0; i < n; i++) {
            seasonAdjusted[i] = y[i] - seasonalTotal[i];
            remainder[i] = seasonAdjusted[i] - trend[i];
        }
        return { trend: trend, seasonals: seasonals, periods: valid, remainder: remainder,
                 seasonAdjusted: seasonAdjusted, seasonalTotal: seasonalTotal };
    }

    /**
     * Extrapolate a fitted seasonal component forward by repeating the most
     * recently observed complete cycle (the seasonal-naive rule STL/MSTL
     * forecasting uses).
     */
    function extendSeasonal(seasonal, period, horizon) {
        var n = seasonal.length, out = zeros(horizon);
        for (var h = 0; h < horizon; h++) {
            var back = period - ((h % period) + 1);          // index inside the last cycle
            out[h] = seasonal[n - 1 - back];
        }
        return out;
    }

    /* ============================================================
     * 5. A very small reverse-mode autodiff engine.
     *    Matrices are row-major Float64Arrays; a tape of closures
     *    plays the gradients back. Enough to express both an NNAR
     *    network and the residual stacks of N-BEATS without any
     *    hand-derived derivatives.
     * ========================================================== */

    function Tensor(rows, cols, data, isParam) {
        this.rows = rows;
        this.cols = cols;
        this.data = data || zeros(rows * cols);
        this.grad = null;
        this.isParam = !!isParam;
    }
    Tensor.prototype.zeroGrad = function () {
        if (!this.grad) this.grad = zeros(this.rows * this.cols);
        else this.grad.fill(0);
    };

    function Graph() { this.tape = []; }
    Graph.prototype.push = function (fn) { this.tape.push(fn); };
    Graph.prototype.backward = function (loss) {
        loss.zeroGrad();
        loss.grad[0] = 1;
        for (var i = this.tape.length - 1; i >= 0; i--) this.tape[i]();
        this.tape.length = 0;
    };
    Graph.prototype.reset = function () { this.tape.length = 0; };

    function needGrad(t) { if (!t.grad) t.grad = zeros(t.rows * t.cols); return t.grad; }

    /** C = A · B */
    Graph.prototype.matmul = function (A, B) {
        var r = A.rows, k = A.cols, c = B.cols;
        var out = new Tensor(r, c);
        var a = A.data, b = B.data, o = out.data, i, j, p, av, ro, rb;
        for (i = 0; i < r; i++) {
            ro = i * c;
            for (p = 0; p < k; p++) {
                av = a[i * k + p];
                if (av === 0) continue;
                rb = p * c;
                for (j = 0; j < c; j++) o[ro + j] += av * b[rb + j];
            }
        }
        var self = this;
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = A.noGrad ? null : needGrad(A), gb = B.noGrad ? null : needGrad(B), ii, jj, pp, gv;
            if (ga) for (ii = 0; ii < r; ii++) {
                for (pp = 0; pp < k; pp++) {
                    var s = 0, rowA = ii * c, rowB = pp * c;
                    for (jj = 0; jj < c; jj++) s += g[rowA + jj] * b[rowB + jj];
                    ga[ii * k + pp] += s;
                }
            }
            if (gb) for (pp = 0; pp < k; pp++) {
                for (ii = 0; ii < r; ii++) {
                    gv = a[ii * k + pp];
                    if (gv === 0) continue;
                    var rg = ii * c, rr = pp * c;
                    for (jj = 0; jj < c; jj++) gb[rr + jj] += gv * g[rg + jj];
                }
            }
            void self;
        });
        return out;
    };

    /** Row-broadcast bias add: out[i,j] = A[i,j] + b[0,j] */
    Graph.prototype.addBias = function (A, b) {
        var r = A.rows, c = A.cols, out = new Tensor(r, c), i, j;
        for (i = 0; i < r; i++) for (j = 0; j < c; j++) out.data[i * c + j] = A.data[i * c + j] + b.data[j];
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A), gb = needGrad(b);
            for (var ii = 0; ii < r; ii++) for (var jj = 0; jj < c; jj++) {
                ga[ii * c + jj] += g[ii * c + jj];
                gb[jj] += g[ii * c + jj];
            }
        });
        return out;
    };

    Graph.prototype.relu = function (A) {
        var n = A.rows * A.cols, out = new Tensor(A.rows, A.cols);
        for (var i = 0; i < n; i++) out.data[i] = A.data[i] > 0 ? A.data[i] : 0;
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A);
            for (var k = 0; k < n; k++) if (A.data[k] > 0) ga[k] += g[k];
        });
        return out;
    };

    Graph.prototype.tanh = function (A) {
        var n = A.rows * A.cols, out = new Tensor(A.rows, A.cols);
        for (var i = 0; i < n; i++) out.data[i] = Math.tanh(A.data[i]);
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A);
            for (var k = 0; k < n; k++) ga[k] += g[k] * (1 - out.data[k] * out.data[k]);
        });
        return out;
    };

    Graph.prototype.add = function (A, B) {
        var n = A.rows * A.cols, out = new Tensor(A.rows, A.cols);
        for (var i = 0; i < n; i++) out.data[i] = A.data[i] + B.data[i];
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A), gb = needGrad(B);
            for (var k = 0; k < n; k++) { ga[k] += g[k]; gb[k] += g[k]; }
        });
        return out;
    };

    Graph.prototype.sub = function (A, B) {
        var n = A.rows * A.cols, out = new Tensor(A.rows, A.cols);
        for (var i = 0; i < n; i++) out.data[i] = A.data[i] - B.data[i];
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A), gb = needGrad(B);
            for (var k = 0; k < n; k++) { ga[k] += g[k]; gb[k] -= g[k]; }
        });
        return out;
    };

    /** Mean squared error against a plain target array. Returns a 1x1 tensor. */
    Graph.prototype.mse = function (pred, target) {
        var n = pred.rows * pred.cols, out = new Tensor(1, 1), s = 0;
        for (var i = 0; i < n; i++) { var d = pred.data[i] - target[i]; s += d * d; }
        out.data[0] = s / n;
        this.push(function () {
            var g = out.grad ? out.grad[0] : 0;
            var gp = needGrad(pred);
            for (var k = 0; k < n; k++) gp[k] += g * 2 * (pred.data[k] - target[k]) / n;
        });
        return out;
    };

    /* ---- parameters & Adam ---------------------------------- */

    function param(rows, cols, rng, scale) {
        var t = new Tensor(rows, cols, null, true);
        if (rng) {
            var s = scale == null ? Math.sqrt(2 / (rows + cols)) : scale;
            for (var i = 0; i < rows * cols; i++) t.data[i] = gaussian(rng) * s;
        }
        t.grad = zeros(rows * cols);
        t.m = zeros(rows * cols);
        t.v = zeros(rows * cols);
        return t;
    }

    function Adam(params, lr) {
        this.params = params;
        this.lr = lr || 0.01;
        this.b1 = 0.9; this.b2 = 0.999; this.eps = 1e-8; this.t = 0;
    }
    Adam.prototype.zeroGrad = function () {
        for (var i = 0; i < this.params.length; i++) this.params[i].grad.fill(0);
    };
    Adam.prototype.step = function (clip) {
        this.t++;
        var bc1 = 1 - Math.pow(this.b1, this.t), bc2 = 1 - Math.pow(this.b2, this.t);
        for (var i = 0; i < this.params.length; i++) {
            var p = this.params[i], n = p.data.length;
            for (var j = 0; j < n; j++) {
                var g = p.grad[j];
                if (!isFinite(g)) g = 0;
                if (clip) g = Math.max(-clip, Math.min(clip, g));
                p.m[j] = this.b1 * p.m[j] + (1 - this.b1) * g;
                p.v[j] = this.b2 * p.v[j] + (1 - this.b2) * g * g;
                p.data[j] -= this.lr * (p.m[j] / bc1) / (Math.sqrt(p.v[j] / bc2) + this.eps);
            }
        }
    };

    /* ============================================================
     * 6. NNAR — neural network autoregression.
     *    A single hidden layer fed with p lagged values and P
     *    seasonal lags, averaged over `repeats` random restarts
     *    (the nnetar convention). Forecasts are produced
     *    recursively, one step at a time.
     * ========================================================== */

    function buildLagMatrix(x, lags) {
        var maxLag = 0, i, j;
        for (i = 0; i < lags.length; i++) maxLag = Math.max(maxLag, lags[i]);
        var n = x.length, rows = n - maxLag, cols = lags.length;
        if (rows <= 0) throw new Error('Not enough observations for the requested lag structure.');
        var X = zeros(rows * cols), Y = zeros(rows);
        for (i = 0; i < rows; i++) {
            var t = i + maxLag;
            for (j = 0; j < cols; j++) X[i * cols + j] = x[t - lags[j]];
            Y[i] = x[t];
        }
        return { X: X, Y: Y, rows: rows, cols: cols, maxLag: maxLag };
    }

    /**
     * Trains one single-hidden-layer network on a fixed design matrix.
     * Hand-written forward/backward over preallocated buffers: the generic
     * autodiff tape allocates a fresh matrix per operation per iteration,
     * which dominates the cost at this size.
     */
    function trainNnarNet(X, Y, rows, cols, size, rng, hp) {
        var i, j, c;
        var W1 = new Float64Array(cols * size), b1 = new Float64Array(size);
        var W2 = new Float64Array(size), b2 = new Float64Array(1);
        var s1 = Math.sqrt(2 / (cols + size)), s2 = Math.sqrt(2 / (size + 1));
        for (i = 0; i < W1.length; i++) W1[i] = gaussian(rng) * s1;
        for (i = 0; i < W2.length; i++) W2[i] = gaussian(rng) * s2;

        var H = new Float64Array(rows * size), out = new Float64Array(rows);
        var dOut = new Float64Array(rows), dH = new Float64Array(rows * size);
        var gW1 = new Float64Array(cols * size), gb1 = new Float64Array(size);
        var gW2 = new Float64Array(size), gb2 = new Float64Array(1);
        var mW1 = new Float64Array(cols * size), vW1 = new Float64Array(cols * size);
        var mb1 = new Float64Array(size), vb1 = new Float64Array(size);
        var mW2 = new Float64Array(size), vW2 = new Float64Array(size);
        var mb2 = new Float64Array(1), vb2 = new Float64Array(1);

        var lr = hp.lr, decay = hp.decay, b1m = 0.9, b2m = 0.999, eps = 1e-8;
        var best = Infinity, bestW1 = null, bestb1 = null, bestW2 = null, bestb2 = 0, stall = 0;
        var lossHistory = [], t = 0;

        function adam(pv, gv, mv, vv) {
            var bc1 = 1 - Math.pow(b1m, t), bc2 = 1 - Math.pow(b2m, t);
            for (var k = 0; k < pv.length; k++) {
                var g = gv[k] + 2 * decay * pv[k];
                if (!isFinite(g)) g = 0;
                if (g > 5) g = 5; else if (g < -5) g = -5;
                mv[k] = b1m * mv[k] + (1 - b1m) * g;
                vv[k] = b2m * vv[k] + (1 - b2m) * g * g;
                pv[k] -= lr * (mv[k] / bc1) / (Math.sqrt(vv[k] / bc2) + eps);
            }
        }

        for (var it = 0; it < hp.iters; it++) {
            // forward
            var loss = 0;
            for (i = 0; i < rows; i++) {
                var acc = b2[0], base = i * size, xb = i * cols;
                for (j = 0; j < size; j++) {
                    var a = b1[j];
                    for (c = 0; c < cols; c++) a += X[xb + c] * W1[c * size + j];
                    var hv = Math.tanh(a);
                    H[base + j] = hv;
                    acc += hv * W2[j];
                }
                out[i] = acc;
                var e = acc - Y[i];
                loss += e * e;
                dOut[i] = 2 * e / rows;
            }
            loss /= rows;

            if (loss < best * (1 - 1e-5)) {
                best = loss; stall = 0;
                bestW1 = Float64Array.from(W1); bestb1 = Float64Array.from(b1);
                bestW2 = Float64Array.from(W2); bestb2 = b2[0];
            } else if (++stall >= hp.patience) {
                break;
            }
            if (it % 25 === 0) lossHistory.push(loss);

            // backward
            gW1.fill(0); gb1.fill(0); gW2.fill(0); gb2[0] = 0;
            for (i = 0; i < rows; i++) {
                var d = dOut[i], b = i * size;
                gb2[0] += d;
                for (j = 0; j < size; j++) {
                    var hv2 = H[b + j];
                    gW2[j] += hv2 * d;
                    dH[b + j] = d * W2[j] * (1 - hv2 * hv2);
                }
            }
            for (i = 0; i < rows; i++) {
                var xb2 = i * cols, hb = i * size;
                for (j = 0; j < size; j++) {
                    var dh = dH[hb + j];
                    if (dh === 0) continue;
                    gb1[j] += dh;
                    for (c = 0; c < cols; c++) gW1[c * size + j] += X[xb2 + c] * dh;
                }
            }
            t++;
            adam(W1, gW1, mW1, vW1);
            adam(b1, gb1, mb1, vb1);
            adam(W2, gW2, mW2, vW2);
            adam(b2, gb2, mb2, vb2);
        }
        if (bestW1) { W1 = bestW1; b1 = bestb1; W2 = bestW2; b2[0] = bestb2; }
        return { W1: W1, b1: b1, W2: W2, b2: b2[0], size: size, cols: cols, loss: lossHistory };
    }

    async function nnarFit(x, opts, ctx) {
        opts = opts || {};
        var p = Math.max(1, opts.p || 1);
        var P = opts.P || 0;
        var m = opts.m || 1;
        var size = opts.size || Math.max(1, Math.ceil((p + P + 1) / 2));
        var repeats = Math.max(1, opts.repeats || 12);
        var rng = opts.rng || mulberry32(opts.seed || 42);
        var hp = {
            iters: opts.iters || 350,
            lr: opts.lr || 0.05,
            decay: opts.decay == null ? 1e-4 : opts.decay,
            patience: opts.patience || 60
        };
        ctx = ctx || {};

        var lags = [], i, j;
        for (i = 1; i <= p; i++) lags.push(i);
        for (var s = 1; s <= P; s++) if (lags.indexOf(s * m) < 0) lags.push(s * m);
        lags.sort(function (a, b) { return a - b; });

        var mu = mean(x), sg = sd(x) || 1;
        var z = zeros(x.length);
        for (i = 0; i < x.length; i++) z[i] = (x[i] - mu) / sg;

        var lm = buildLagMatrix(z, lags);
        var nets = [], firstLoss = [];

        for (var r = 0; r < repeats; r++) {
            nets.push(trainNnarNet(lm.X, lm.Y, lm.rows, lm.cols, size, rng, hp));
            if (!firstLoss.length) firstLoss = nets[0].loss;
            if (ctx.progress) ctx.progress((r + 1) / repeats, 'Training network ' + (r + 1) + ' of ' + repeats);
            if (ctx.yield) await ctx.yield();
        }

        function forwardOne(net, input) {
            var acc = net.b2, k = net.size;
            for (var jj = 0; jj < k; jj++) {
                var a = net.b1[jj];
                for (var cc = 0; cc < net.cols; cc++) a += input[cc] * net.W1[cc * k + jj];
                acc += Math.tanh(a) * net.W2[jj];
            }
            return acc;
        }
        function ensemblePredict(input) {
            var acc = 0;
            for (var q = 0; q < nets.length; q++) acc += forwardOne(nets[q], input);
            return acc / nets.length;
        }

        var fitted = new Array(x.length).fill(NaN);
        var inp = new Array(lags.length);
        for (i = 0; i < lm.rows; i++) {
            for (j = 0; j < lags.length; j++) inp[j] = lm.X[i * lm.cols + j];
            fitted[i + lm.maxLag] = ensemblePredict(inp) * sg + mu;
        }

        function forecast(h) {
            var hist = Array.prototype.slice.call(z), out = zeros(h);
            for (var step = 0; step < h; step++) {
                var input = [];
                for (var q = 0; q < lags.length; q++) input.push(hist[hist.length - lags[q]]);
                var v = ensemblePredict(input);
                hist.push(v);
                out[step] = v * sg + mu;
            }
            return out;
        }

        /** Recursive forecast paths with residuals bootstrapped back in. */
        function simulate(h, paths, resid, prng) {
            var sims = [], rz = [];
            resid.forEach(function (e) { if (isFinite(e)) rz.push(e / sg); });
            for (var q = 0; q < paths; q++) {
                var hist = Array.prototype.slice.call(z), row = zeros(h);
                for (var step = 0; step < h; step++) {
                    var input = [];
                    for (var k = 0; k < lags.length; k++) input.push(hist[hist.length - lags[k]]);
                    var v = ensemblePredict(input) + (rz.length ? rz[Math.floor(prng() * rz.length)] : 0);
                    hist.push(v);
                    row[step] = v * sg + mu;
                }
                sims.push(row);
            }
            return sims;
        }

        return { lags: lags, size: size, repeats: repeats, fitted: fitted,
                 forecast: forecast, simulate: simulate, loss: firstLoss,
                 nParams: lags.length * size + size + size + 1 };
    }

    function snapshot(params) {
        return params.map(function (p) { return Float64Array.from(p.data); });
    }
    function restore(params, state) {
        for (var i = 0; i < params.length; i++) params[i].data.set(state[i]);
    }

    /* ============================================================
     * 7. STR — seasonal-trend decomposition using regression.
     *    Dokumentov & Hyndman: the components are the solution of a
     *    penalised least-squares problem, which lets the seasonal
     *    shape evolve slowly instead of being fixed. Solved
     *    matrix-free with conjugate gradients.
     *
     *      min  || y - tau - sum_k s_k ||^2
     *         + lT || D2 tau ||^2
     *         + sum_k [ lV || D2_cycle s_k ||^2      (slow evolution)
     *                 + lS || D2_phase s_k ||^2      (smooth shape)
     *                 + l0 || cycle sums of s_k ||^2 ]  (identifiability)
     * ========================================================== */

    function strDecompose(y, periods, opts) {
        opts = opts || {};
        var n = y.length, i, k, t;
        var valid = (periods || [])
            .map(function (p) { return Math.round(p); })
            .filter(function (p) { return p >= 2 && n >= 2 * p; })
            .sort(function (a, b) { return a - b; })
            .filter(function (p, idx, arr) { return idx === 0 || p !== arr[idx - 1]; });
        var K = valid.length;

        var mu = mean(y), sg = sd(y) || 1;
        var yz = zeros(n);
        for (i = 0; i < n; i++) yz[i] = (y[i] - mu) / sg;

        // --- trend basis: linear splines on a coarse knot grid. A trend this
        // smooth is fully described by knots every h points, and solving for
        // ~n/h unknowns instead of n makes the system far better conditioned.
        var w = opts.trendWindow || Math.max(7, 1.5 * (valid[K - 1] || Math.max(7, n / 8)));
        var lTfull = opts.lambdaTrend != null ? opts.lambdaTrend : Math.pow(w / (2 * Math.PI), 4);
        var h = Math.max(1, Math.min(Math.round(w / 8), Math.floor((n - 1) / 3) || 1));
        var nK = Math.max(2, Math.ceil((n - 1) / h) + 1);
        var knotPos = new Int32Array(nK);
        for (k = 0; k < nK; k++) knotPos[k] = Math.min(k * h, n - 1);
        knotPos[nK - 1] = n - 1;
        var lT = lTfull / Math.pow(h, 3);          // penalty rescaled for knot spacing

        var kIdx = new Int32Array(n), kW = zeros(n);
        for (t = 0; t < n; t++) {
            var k0 = Math.min(Math.floor(t / h), nK - 2);
            var span = knotPos[k0 + 1] - knotPos[k0] || 1;
            kIdx[t] = k0;
            kW[t] = (t - knotPos[k0]) / span;      // weight on knot k0+1
        }

        var l0 = opts.lambdaZero != null ? opts.lambdaZero : 100;
        var lV = [], lS = [];
        for (k = 0; k < K; k++) {
            var cycles = n / valid[k];
            var flexWin = opts.seasonalFlex != null ? opts.seasonalFlex : Math.max(10, cycles);
            lV.push(opts.lambdaEvolve != null ? opts.lambdaEvolve : Math.pow(flexWin / (2 * Math.PI), 2));
            var shapeWin = opts.shapeWindow != null ? opts.shapeWindow
                : (valid[k] >= 60 && cycles < 12 ? Math.max(3, valid[k] / 24) : 3);
            lS.push(opts.lambdaShape != null ? opts.lambdaShape : Math.pow(shapeWin / (2 * Math.PI), 4));
        }

        var N = nK + K * n;
        var SOFF = nK;                              // seasonal blocks start here

        // Cycles are aligned to the END of the series, so the most recent
        // cycle is always complete: any partial cycle sits at the start,
        // where it cannot distort the values the forecast extrapolates from.
        var phasePrev = [], phaseNext = [], cycleStarts = [];
        for (k = 0; k < K; k++) {
            var m = valid[k], pp = new Int32Array(n), pn = new Int32Array(n);
            var starts = [];
            for (var cs = n - m; cs >= 0; cs -= m) starts.unshift(cs);
            cycleStarts.push(starts);
            for (i = 0; i < n; i++) {
                var back = n - 1 - i;
                var ph = back % m;                       // 0 = last point of its cycle
                var base = i + ph;                       // last index of this cycle
                var prevIdx = base - ((ph + 1) % m);
                var nextIdx = base - ((ph - 1 + m) % m);
                pp[i] = prevIdx >= 0 && prevIdx < n ? prevIdx : i;
                pn[i] = nextIdx >= 0 && nextIdx < n ? nextIdx : i;
            }
            phasePrev.push(pp); phaseNext.push(pn);
        }

        function trendAt(x, tt) {
            var k0 = kIdx[tt], a = kW[tt];
            return x[k0] * (1 - a) + x[k0 + 1] * a;
        }

        /** Applies (A'A + P) to a stacked parameter vector. */
        function applyOp(x, out) {
            out.fill(0);
            var tt, kk, mm, off;
            for (tt = 0; tt < n; tt++) {
                var r = trendAt(x, tt);
                for (kk = 0; kk < K; kk++) r += x[SOFF + kk * n + tt];
                var k0 = kIdx[tt], a = kW[tt];
                out[k0] += (1 - a) * r;
                out[k0 + 1] += a * r;
                for (kk = 0; kk < K; kk++) out[SOFF + kk * n + tt] += r;
            }
            for (kk = 2; kk < nK; kk++) {
                var c = lT * (x[kk] - 2 * x[kk - 1] + x[kk - 2]);
                out[kk] += c; out[kk - 1] -= 2 * c; out[kk - 2] += c;
            }
            for (kk = 0; kk < K; kk++) {
                off = SOFF + kk * n; mm = valid[kk];
                for (tt = mm; tt < n; tt++) {
                    var cv = lV[kk] * (x[off + tt] - x[off + tt - mm]);
                    out[off + tt] += cv; out[off + tt - mm] -= cv;
                }
                var pp2 = phasePrev[kk], pn2 = phaseNext[kk];
                for (tt = 0; tt < n; tt++) {
                    var cs = lS[kk] * (x[off + pn2[tt]] - 2 * x[off + tt] + x[off + pp2[tt]]);
                    out[off + pn2[tt]] += cs; out[off + tt] -= 2 * cs; out[off + pp2[tt]] += cs;
                }
                var starts2 = cycleStarts[kk];
                for (var ci = 0; ci < starts2.length; ci++) {
                    var st = starts2[ci], en = st + mm, sum = 0;
                    for (tt = st; tt < en; tt++) sum += x[off + tt];
                    var cz = l0 * sum;
                    for (tt = st; tt < en; tt++) out[off + tt] += cz;
                }
            }
        }

        /** Diagonal of the same operator, for Jacobi preconditioning. */
        function buildDiag() {
            var d = zeros(N), tt, kk, mm, off;
            for (tt = 0; tt < n; tt++) {
                var k0 = kIdx[tt], a = kW[tt];
                d[k0] += (1 - a) * (1 - a);
                d[k0 + 1] += a * a;
                for (kk = 0; kk < K; kk++) d[SOFF + kk * n + tt] += 1;
            }
            for (kk = 2; kk < nK; kk++) { d[kk] += lT; d[kk - 1] += 4 * lT; d[kk - 2] += lT; }
            for (kk = 0; kk < K; kk++) {
                off = SOFF + kk * n; mm = valid[kk];
                for (tt = mm; tt < n; tt++) { d[off + tt] += lV[kk]; d[off + tt - mm] += lV[kk]; }
                var pp3 = phasePrev[kk], pn3 = phaseNext[kk];
                for (tt = 0; tt < n; tt++) {
                    d[off + pn3[tt]] += lS[kk]; d[off + tt] += 4 * lS[kk]; d[off + pp3[tt]] += lS[kk];
                }
                var starts3 = cycleStarts[kk];
                for (var ci2 = 0; ci2 < starts3.length; ci2++) {
                    for (tt = starts3[ci2]; tt < starts3[ci2] + mm; tt++) d[off + tt] += l0;
                }
            }
            for (tt = 0; tt < N; tt++) if (!(d[tt] > 1e-12)) d[tt] = 1;
            return d;
        }

        var b = zeros(N);
        for (t = 0; t < n; t++) {
            var kk0 = kIdx[t], aa = kW[t];
            b[kk0] += (1 - aa) * yz[t];
            b[kk0 + 1] += aa * yz[t];
            for (k = 0; k < K; k++) b[SOFF + k * n + t] = yz[t];
        }

        var diag = buildDiag();
        var xsol = zeros(N), r = Float64Array.from(b);
        var zvec = zeros(N), pvec = zeros(N), Ap = zeros(N);
        for (i = 0; i < N; i++) { zvec[i] = r[i] / diag[i]; pvec[i] = zvec[i]; }
        var rz = dot(r, zvec), bnorm = Math.sqrt(dot(b, b)) || 1;
        var maxIter = opts.maxIter || 4000;
        var tol = opts.tol || 1e-8;
        var iterUsed = 0, converged = false;
        for (var itc = 0; itc < maxIter; itc++) {
            applyOp(pvec, Ap);
            var pap = dot(pvec, Ap);
            if (!isFinite(pap) || pap <= 0) break;
            var alpha = rz / pap;
            for (i = 0; i < N; i++) { xsol[i] += alpha * pvec[i]; r[i] -= alpha * Ap[i]; }
            iterUsed = itc + 1;
            if (Math.sqrt(dot(r, r)) / bnorm < tol) { converged = true; break; }
            for (i = 0; i < N; i++) zvec[i] = r[i] / diag[i];
            var rz2 = dot(r, zvec);
            var beta = rz2 / rz;
            for (i = 0; i < N; i++) pvec[i] = zvec[i] + beta * pvec[i];
            rz = rz2;
        }

        var trend = zeros(n), seasonals = [], seasonalTotal = zeros(n),
            seasonAdjusted = zeros(n), remainder = zeros(n);
        for (t = 0; t < n; t++) trend[t] = trendAt(xsol, t) * sg + mu;
        for (k = 0; k < K; k++) {
            var comp = zeros(n);
            for (t = 0; t < n; t++) { comp[t] = xsol[SOFF + k * n + t] * sg; seasonalTotal[t] += comp[t]; }
            seasonals.push(comp);
        }
        for (t = 0; t < n; t++) {
            seasonAdjusted[t] = y[t] - seasonalTotal[t];
            remainder[t] = seasonAdjusted[t] - trend[t];
        }
        return { trend: trend, seasonals: seasonals, periods: valid, remainder: remainder,
                 seasonAdjusted: seasonAdjusted, seasonalTotal: seasonalTotal,
                 iterations: iterUsed, converged: converged, knots: nK, lambdaTrend: lTfull };
    }

    function dot(a, b) {
        var s = 0;
        for (var i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
    }

    /**
     * Extrapolate an STR seasonal component. Because STR lets the profile
     * evolve, we take the last cycle and continue the per-phase drift
     * observed between the last two cycles (damped).
     */
    /**
     * Extrapolate an STR seasonal component. STR lets the profile evolve, so
     * the single last cycle is noisy; averaging the most recent cycles with
     * exponentially decaying weights keeps the recent shape without the noise.
     */
    function extendSeasonalSTR(seasonal, period, horizon, cyclesBack, decay) {
        var n = seasonal.length, out = zeros(horizon);
        var available = Math.floor(n / period);
        var J = Math.max(1, Math.min(cyclesBack == null ? 5 : cyclesBack, available));
        decay = decay == null ? 0.7 : decay;
        for (var h = 0; h < horizon; h++) {
            var back = period - ((h % period) + 1);
            var num = 0, den = 0;
            for (var j = 0; j < J; j++) {
                var idx = n - 1 - back - j * period;
                if (idx < 0) break;
                var w = Math.pow(decay, j);
                num += w * seasonal[idx];
                den += w;
            }
            out[h] = den ? num / den : 0;
        }
        return out;
    }

    /* ============================================================
     * 5. A very small reverse-mode autodiff engine.
     *    Matrices are row-major Float64Arrays; a tape of closures
     *    plays the gradients back. Enough to express both an NNAR
     *    network and the residual stacks of N-BEATS without any
     *    hand-derived derivatives.
     * ========================================================== */

    function Tensor(rows, cols, data, isParam) {
        this.rows = rows;
        this.cols = cols;
        this.data = data || zeros(rows * cols);
        this.grad = null;
        this.isParam = !!isParam;
    }
    Tensor.prototype.zeroGrad = function () {
        if (!this.grad) this.grad = zeros(this.rows * this.cols);
        else this.grad.fill(0);
    };

    function Graph() { this.tape = []; }
    Graph.prototype.push = function (fn) { this.tape.push(fn); };
    Graph.prototype.backward = function (loss) {
        loss.zeroGrad();
        loss.grad[0] = 1;
        for (var i = this.tape.length - 1; i >= 0; i--) this.tape[i]();
        this.tape.length = 0;
    };
    Graph.prototype.reset = function () { this.tape.length = 0; };

    function needGrad(t) { if (!t.grad) t.grad = zeros(t.rows * t.cols); return t.grad; }

    /** C = A · B */
    Graph.prototype.matmul = function (A, B) {
        var r = A.rows, k = A.cols, c = B.cols;
        var out = new Tensor(r, c);
        var a = A.data, b = B.data, o = out.data, i, j, p, av, ro, rb;
        for (i = 0; i < r; i++) {
            ro = i * c;
            for (p = 0; p < k; p++) {
                av = a[i * k + p];
                if (av === 0) continue;
                rb = p * c;
                for (j = 0; j < c; j++) o[ro + j] += av * b[rb + j];
            }
        }
        var self = this;
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = A.noGrad ? null : needGrad(A), gb = B.noGrad ? null : needGrad(B), ii, jj, pp, gv;
            if (ga) for (ii = 0; ii < r; ii++) {
                for (pp = 0; pp < k; pp++) {
                    var s = 0, rowA = ii * c, rowB = pp * c;
                    for (jj = 0; jj < c; jj++) s += g[rowA + jj] * b[rowB + jj];
                    ga[ii * k + pp] += s;
                }
            }
            if (gb) for (pp = 0; pp < k; pp++) {
                for (ii = 0; ii < r; ii++) {
                    gv = a[ii * k + pp];
                    if (gv === 0) continue;
                    var rg = ii * c, rr = pp * c;
                    for (jj = 0; jj < c; jj++) gb[rr + jj] += gv * g[rg + jj];
                }
            }
            void self;
        });
        return out;
    };

    /** Row-broadcast bias add: out[i,j] = A[i,j] + b[0,j] */
    Graph.prototype.addBias = function (A, b) {
        var r = A.rows, c = A.cols, out = new Tensor(r, c), i, j;
        for (i = 0; i < r; i++) for (j = 0; j < c; j++) out.data[i * c + j] = A.data[i * c + j] + b.data[j];
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A), gb = needGrad(b);
            for (var ii = 0; ii < r; ii++) for (var jj = 0; jj < c; jj++) {
                ga[ii * c + jj] += g[ii * c + jj];
                gb[jj] += g[ii * c + jj];
            }
        });
        return out;
    };

    Graph.prototype.relu = function (A) {
        var n = A.rows * A.cols, out = new Tensor(A.rows, A.cols);
        for (var i = 0; i < n; i++) out.data[i] = A.data[i] > 0 ? A.data[i] : 0;
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A);
            for (var k = 0; k < n; k++) if (A.data[k] > 0) ga[k] += g[k];
        });
        return out;
    };

    Graph.prototype.tanh = function (A) {
        var n = A.rows * A.cols, out = new Tensor(A.rows, A.cols);
        for (var i = 0; i < n; i++) out.data[i] = Math.tanh(A.data[i]);
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A);
            for (var k = 0; k < n; k++) ga[k] += g[k] * (1 - out.data[k] * out.data[k]);
        });
        return out;
    };

    Graph.prototype.add = function (A, B) {
        var n = A.rows * A.cols, out = new Tensor(A.rows, A.cols);
        for (var i = 0; i < n; i++) out.data[i] = A.data[i] + B.data[i];
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A), gb = needGrad(B);
            for (var k = 0; k < n; k++) { ga[k] += g[k]; gb[k] += g[k]; }
        });
        return out;
    };

    Graph.prototype.sub = function (A, B) {
        var n = A.rows * A.cols, out = new Tensor(A.rows, A.cols);
        for (var i = 0; i < n; i++) out.data[i] = A.data[i] - B.data[i];
        this.push(function () {
            var g = out.grad; if (!g) return;
            var ga = needGrad(A), gb = needGrad(B);
            for (var k = 0; k < n; k++) { ga[k] += g[k]; gb[k] -= g[k]; }
        });
        return out;
    };

    /** Mean squared error against a plain target array. Returns a 1x1 tensor. */
    Graph.prototype.mse = function (pred, target) {
        var n = pred.rows * pred.cols, out = new Tensor(1, 1), s = 0;
        for (var i = 0; i < n; i++) { var d = pred.data[i] - target[i]; s += d * d; }
        out.data[0] = s / n;
        this.push(function () {
            var g = out.grad ? out.grad[0] : 0;
            var gp = needGrad(pred);
            for (var k = 0; k < n; k++) gp[k] += g * 2 * (pred.data[k] - target[k]) / n;
        });
        return out;
    };

    /* ---- parameters & Adam ---------------------------------- */

    function param(rows, cols, rng, scale) {
        var t = new Tensor(rows, cols, null, true);
        if (rng) {
            var s = scale == null ? Math.sqrt(2 / (rows + cols)) : scale;
            for (var i = 0; i < rows * cols; i++) t.data[i] = gaussian(rng) * s;
        }
        t.grad = zeros(rows * cols);
        t.m = zeros(rows * cols);
        t.v = zeros(rows * cols);
        return t;
    }

    function Adam(params, lr) {
        this.params = params;
        this.lr = lr || 0.01;
        this.b1 = 0.9; this.b2 = 0.999; this.eps = 1e-8; this.t = 0;
    }
    Adam.prototype.zeroGrad = function () {
        for (var i = 0; i < this.params.length; i++) this.params[i].grad.fill(0);
    };
    Adam.prototype.step = function (clip) {
        this.t++;
        var bc1 = 1 - Math.pow(this.b1, this.t), bc2 = 1 - Math.pow(this.b2, this.t);
        for (var i = 0; i < this.params.length; i++) {
            var p = this.params[i], n = p.data.length;
            for (var j = 0; j < n; j++) {
                var g = p.grad[j];
                if (!isFinite(g)) g = 0;
                if (clip) g = Math.max(-clip, Math.min(clip, g));
                p.m[j] = this.b1 * p.m[j] + (1 - this.b1) * g;
                p.v[j] = this.b2 * p.v[j] + (1 - this.b2) * g * g;
                p.data[j] -= this.lr * (p.m[j] / bc1) / (Math.sqrt(p.v[j] / bc2) + this.eps);
            }
        }
    };

    /* ============================================================
     * 6. NNAR — neural network autoregression.
     *    A single hidden layer fed with p lagged values and P
     *    seasonal lags, averaged over `repeats` random restarts
     *    (the nnetar convention). Forecasts are produced
     *    recursively, one step at a time.
     * ========================================================== */

    function buildLagMatrix(x, lags) {
        var maxLag = 0, i, j;
        for (i = 0; i < lags.length; i++) maxLag = Math.max(maxLag, lags[i]);
        var n = x.length, rows = n - maxLag, cols = lags.length;
        if (rows <= 0) throw new Error('Not enough observations for the requested lag structure.');
        var X = zeros(rows * cols), Y = zeros(rows);
        for (i = 0; i < rows; i++) {
            var t = i + maxLag;
            for (j = 0; j < cols; j++) X[i * cols + j] = x[t - lags[j]];
            Y[i] = x[t];
        }
        return { X: X, Y: Y, rows: rows, cols: cols, maxLag: maxLag };
    }

    async function nnarFit(x, opts, ctx) {
        opts = opts || {};
        var p = Math.max(1, opts.p || 1);
        var P = opts.P || 0;
        var m = opts.m || 1;
        var size = opts.size || Math.max(1, Math.ceil((p + P + 1) / 2));
        var repeats = Math.max(1, opts.repeats || 12);
        var iters = opts.iters || 350;
        var lr = opts.lr || 0.05;
        var decay = opts.decay == null ? 1e-4 : opts.decay;   // weight decay, as in nnetar
        var rng = opts.rng || mulberry32(opts.seed || 42);
        ctx = ctx || {};

        var lags = [];
        for (var i = 1; i <= p; i++) lags.push(i);
        for (var s = 1; s <= P; s++) if (lags.indexOf(s * m) < 0) lags.push(s * m);
        lags.sort(function (a, b) { return a - b; });

        var mu = mean(x), sg = sd(x) || 1;
        var z = zeros(x.length);
        for (i = 0; i < x.length; i++) z[i] = (x[i] - mu) / sg;

        var lm = buildLagMatrix(z, lags);
        var nets = [], histories = [];

        for (var r = 0; r < repeats; r++) {
            var g = new Graph();
            var W1 = param(lm.cols, size, rng, Math.sqrt(2 / (lm.cols + size)));
            var b1 = param(1, size, null);
            var W2 = param(size, 1, rng, Math.sqrt(2 / (size + 1)));
            var b2 = param(1, 1, null);
            var params = [W1, b1, W2, b2];
            var opt = new Adam(params, lr);
            var Xt = new Tensor(lm.rows, lm.cols, lm.X);
            var best = Infinity, bestState = null, hist = [], stall = 0;
            var patience = opts.patience || 60;

            for (var it = 0; it < iters; it++) {
                g.reset();
                opt.zeroGrad();
                Xt.grad = null;
                var h = g.tanh(g.addBias(g.matmul(Xt, W1), b1));
                var out = g.addBias(g.matmul(h, W2), b2);
                var loss = g.mse(out, lm.Y);
                g.backward(loss);
                // weight decay (L2) applied straight to the gradients
                if (decay) {
                    for (var q = 0; q < params.length; q++) {
                        var pr = params[q];
                        for (var d = 0; d < pr.data.length; d++) pr.grad[d] += 2 * decay * pr.data[d];
                    }
                }
                opt.step(5);
                if (loss.data[0] < best * (1 - 1e-5)) {
                    best = loss.data[0]; bestState = snapshot(params); stall = 0;
                } else if (++stall >= patience) {
                    break;                                  // converged; stop burning cycles
                }
                if (it % 25 === 0) {
                    hist.push(loss.data[0]);
                    if (ctx.progress) ctx.progress((r + it / iters) / repeats, 'Training network ' + (r + 1) + '/' + repeats);
                    if (ctx.yield) await ctx.yield();
                }
            }
            if (bestState) restore(params, bestState);
            nets.push({ W1: W1, b1: b1, W2: W2, b2: b2 });
            histories.push(hist);
        }

        function forwardOne(net, input) {           // input: plain array, already scaled
            var k = net.W1.cols, acc = 0;
            for (var j = 0; j < k; j++) {
                var a = net.b1.data[j];
                for (var i2 = 0; i2 < input.length; i2++) a += input[i2] * net.W1.data[i2 * k + j];
                acc += Math.tanh(a) * net.W2.data[j];
            }
            return acc + net.b2.data[0];
        }

        function ensemblePredict(input) {
            var s2 = 0;
            for (var i2 = 0; i2 < nets.length; i2++) s2 += forwardOne(nets[i2], input);
            return s2 / nets.length;
        }

        // one-step-ahead in-sample fit
        var fitted = new Array(x.length).fill(NaN);
        var inp = new Array(lags.length);
        for (i = 0; i < lm.rows; i++) {
            for (var j2 = 0; j2 < lags.length; j2++) inp[j2] = lm.X[i * lm.cols + j2];
            fitted[i + lm.maxLag] = ensemblePredict(inp) * sg + mu;
        }

        function forecast(h) {
            var histz = Array.prototype.slice.call(z);
            var out = zeros(h);
            for (var step = 0; step < h; step++) {
                var input = [];
                for (var j3 = 0; j3 < lags.length; j3++) input.push(histz[histz.length - lags[j3]]);
                var v = ensemblePredict(input);
                histz.push(v);
                out[step] = v * sg + mu;
            }
            return out;
        }

        /** Recursive forecast paths with residuals bootstrapped back in. */
        function simulate(h, paths, resid, prng) {
            var sims = [];
            var rz = resid.filter(isFinite).map(function (e) { return e / sg; });
            for (var s3 = 0; s3 < paths; s3++) {
                var histz = Array.prototype.slice.call(z), row = zeros(h);
                for (var step = 0; step < h; step++) {
                    var input = [];
                    for (var j4 = 0; j4 < lags.length; j4++) input.push(histz[histz.length - lags[j4]]);
                    var v = ensemblePredict(input) + (rz.length ? rz[Math.floor(prng() * rz.length)] : 0);
                    histz.push(v);
                    row[step] = v * sg + mu;
                }
                sims.push(row);
            }
            return sims;
        }

        return { lags: lags, size: size, repeats: repeats, fitted: fitted,
                 forecast: forecast, simulate: simulate, loss: histories[0] || [],
                 nParams: (lags.length * size + size + size + 1) };
    }

    function snapshot(params) {
        return params.map(function (p) { return Float64Array.from(p.data); });
    }
    function restore(params, state) {
        for (var i = 0; i < params.length; i++) params[i].data.set(state[i]);
    }

    /* ============================================================
     * 7. STR — seasonal-trend decomposition using regression.
     *    Dokumentov & Hyndman: the components are the solution of a
     *    penalised least-squares problem, which lets the seasonal
     *    shape evolve slowly instead of being fixed. Solved
     *    matrix-free with conjugate gradients.
     *
     *      min  || y - tau - sum_k s_k ||^2
     *         + lT || D2 tau ||^2
     *         + sum_k [ lV || D2_cycle s_k ||^2      (slow evolution)
     *                 + lS || D2_phase s_k ||^2      (smooth shape)
     *                 + l0 || cycle sums of s_k ||^2 ]  (identifiability)
     * ========================================================== */

    function strDecompose(y, periods, opts) {
        opts = opts || {};
        var n = y.length, i, k, t;
        var valid = (periods || [])
            .map(function (p) { return Math.round(p); })
            .filter(function (p) { return p >= 2 && n >= 2 * p; })
            .sort(function (a, b) { return a - b; })
            .filter(function (p, idx, arr) { return idx === 0 || p !== arr[idx - 1]; });
        var K = valid.length;

        var mu = mean(y), sg = sd(y) || 1;
        var yz = zeros(n);
        for (i = 0; i < n; i++) yz[i] = (y[i] - mu) / sg;

        // --- trend basis: linear splines on a coarse knot grid. A trend this
        // smooth is fully described by knots every h points, and solving for
        // ~n/h unknowns instead of n makes the system far better conditioned.
        var w = opts.trendWindow || Math.max(7, 1.5 * (valid[K - 1] || Math.max(7, n / 8)));
        var lTfull = opts.lambdaTrend != null ? opts.lambdaTrend : Math.pow(w / (2 * Math.PI), 4);
        var h = Math.max(1, Math.min(Math.round(w / 8), Math.floor((n - 1) / 3) || 1));
        var nK = Math.max(2, Math.ceil((n - 1) / h) + 1);
        var knotPos = new Int32Array(nK);
        for (k = 0; k < nK; k++) knotPos[k] = Math.min(k * h, n - 1);
        knotPos[nK - 1] = n - 1;
        var lT = lTfull / Math.pow(h, 3);          // penalty rescaled for knot spacing

        var kIdx = new Int32Array(n), kW = zeros(n);
        for (t = 0; t < n; t++) {
            var k0 = Math.min(Math.floor(t / h), nK - 2);
            var span = knotPos[k0 + 1] - knotPos[k0] || 1;
            kIdx[t] = k0;
            kW[t] = (t - knotPos[k0]) / span;      // weight on knot k0+1
        }

        var l0 = opts.lambdaZero != null ? opts.lambdaZero : 100;
        var lV = [], lS = [];
        for (k = 0; k < K; k++) {
            var cycles = n / valid[k];
            var flexWin = opts.seasonalFlex != null ? opts.seasonalFlex : Math.max(10, cycles);
            lV.push(opts.lambdaEvolve != null ? opts.lambdaEvolve : Math.pow(flexWin / (2 * Math.PI), 2));
            var shapeWin = opts.shapeWindow != null ? opts.shapeWindow
                : (valid[k] >= 60 && cycles < 12 ? Math.max(3, valid[k] / 24) : 3);
            lS.push(opts.lambdaShape != null ? opts.lambdaShape : Math.pow(shapeWin / (2 * Math.PI), 4));
        }

        var N = nK + K * n;
        var SOFF = nK;                              // seasonal blocks start here

        // Cycles are aligned to the END of the series, so the most recent
        // cycle is always complete: any partial cycle sits at the start,
        // where it cannot distort the values the forecast extrapolates from.
        var phasePrev = [], phaseNext = [], cycleStarts = [];
        for (k = 0; k < K; k++) {
            var m = valid[k], pp = new Int32Array(n), pn = new Int32Array(n);
            var starts = [];
            for (var cs = n - m; cs >= 0; cs -= m) starts.unshift(cs);
            cycleStarts.push(starts);
            for (i = 0; i < n; i++) {
                var back = n - 1 - i;
                var ph = back % m;                       // 0 = last point of its cycle
                var base = i + ph;                       // last index of this cycle
                var prevIdx = base - ((ph + 1) % m);
                var nextIdx = base - ((ph - 1 + m) % m);
                pp[i] = prevIdx >= 0 && prevIdx < n ? prevIdx : i;
                pn[i] = nextIdx >= 0 && nextIdx < n ? nextIdx : i;
            }
            phasePrev.push(pp); phaseNext.push(pn);
        }

        function trendAt(x, tt) {
            var k0 = kIdx[tt], a = kW[tt];
            return x[k0] * (1 - a) + x[k0 + 1] * a;
        }

        /** Applies (A'A + P) to a stacked parameter vector. */
        function applyOp(x, out) {
            out.fill(0);
            var tt, kk, mm, off;
            for (tt = 0; tt < n; tt++) {
                var r = trendAt(x, tt);
                for (kk = 0; kk < K; kk++) r += x[SOFF + kk * n + tt];
                var k0 = kIdx[tt], a = kW[tt];
                out[k0] += (1 - a) * r;
                out[k0 + 1] += a * r;
                for (kk = 0; kk < K; kk++) out[SOFF + kk * n + tt] += r;
            }
            for (kk = 2; kk < nK; kk++) {
                var c = lT * (x[kk] - 2 * x[kk - 1] + x[kk - 2]);
                out[kk] += c; out[kk - 1] -= 2 * c; out[kk - 2] += c;
            }
            for (kk = 0; kk < K; kk++) {
                off = SOFF + kk * n; mm = valid[kk];
                for (tt = mm; tt < n; tt++) {
                    var cv = lV[kk] * (x[off + tt] - x[off + tt - mm]);
                    out[off + tt] += cv; out[off + tt - mm] -= cv;
                }
                var pp2 = phasePrev[kk], pn2 = phaseNext[kk];
                for (tt = 0; tt < n; tt++) {
                    var cs = lS[kk] * (x[off + pn2[tt]] - 2 * x[off + tt] + x[off + pp2[tt]]);
                    out[off + pn2[tt]] += cs; out[off + tt] -= 2 * cs; out[off + pp2[tt]] += cs;
                }
                var starts2 = cycleStarts[kk];
                for (var ci = 0; ci < starts2.length; ci++) {
                    var st = starts2[ci], en = st + mm, sum = 0;
                    for (tt = st; tt < en; tt++) sum += x[off + tt];
                    var cz = l0 * sum;
                    for (tt = st; tt < en; tt++) out[off + tt] += cz;
                }
            }
        }

        /** Diagonal of the same operator, for Jacobi preconditioning. */
        function buildDiag() {
            var d = zeros(N), tt, kk, mm, off;
            for (tt = 0; tt < n; tt++) {
                var k0 = kIdx[tt], a = kW[tt];
                d[k0] += (1 - a) * (1 - a);
                d[k0 + 1] += a * a;
                for (kk = 0; kk < K; kk++) d[SOFF + kk * n + tt] += 1;
            }
            for (kk = 2; kk < nK; kk++) { d[kk] += lT; d[kk - 1] += 4 * lT; d[kk - 2] += lT; }
            for (kk = 0; kk < K; kk++) {
                off = SOFF + kk * n; mm = valid[kk];
                for (tt = mm; tt < n; tt++) { d[off + tt] += lV[kk]; d[off + tt - mm] += lV[kk]; }
                var pp3 = phasePrev[kk], pn3 = phaseNext[kk];
                for (tt = 0; tt < n; tt++) {
                    d[off + pn3[tt]] += lS[kk]; d[off + tt] += 4 * lS[kk]; d[off + pp3[tt]] += lS[kk];
                }
                var starts3 = cycleStarts[kk];
                for (var ci2 = 0; ci2 < starts3.length; ci2++) {
                    for (tt = starts3[ci2]; tt < starts3[ci2] + mm; tt++) d[off + tt] += l0;
                }
            }
            for (tt = 0; tt < N; tt++) if (!(d[tt] > 1e-12)) d[tt] = 1;
            return d;
        }

        var b = zeros(N);
        for (t = 0; t < n; t++) {
            var kk0 = kIdx[t], aa = kW[t];
            b[kk0] += (1 - aa) * yz[t];
            b[kk0 + 1] += aa * yz[t];
            for (k = 0; k < K; k++) b[SOFF + k * n + t] = yz[t];
        }

        var diag = buildDiag();
        var xsol = zeros(N), r = Float64Array.from(b);
        var zvec = zeros(N), pvec = zeros(N), Ap = zeros(N);
        for (i = 0; i < N; i++) { zvec[i] = r[i] / diag[i]; pvec[i] = zvec[i]; }
        var rz = dot(r, zvec), bnorm = Math.sqrt(dot(b, b)) || 1;
        var maxIter = opts.maxIter || 4000;
        var tol = opts.tol || 1e-8;
        var iterUsed = 0, converged = false;
        for (var itc = 0; itc < maxIter; itc++) {
            applyOp(pvec, Ap);
            var pap = dot(pvec, Ap);
            if (!isFinite(pap) || pap <= 0) break;
            var alpha = rz / pap;
            for (i = 0; i < N; i++) { xsol[i] += alpha * pvec[i]; r[i] -= alpha * Ap[i]; }
            iterUsed = itc + 1;
            if (Math.sqrt(dot(r, r)) / bnorm < tol) { converged = true; break; }
            for (i = 0; i < N; i++) zvec[i] = r[i] / diag[i];
            var rz2 = dot(r, zvec);
            var beta = rz2 / rz;
            for (i = 0; i < N; i++) pvec[i] = zvec[i] + beta * pvec[i];
            rz = rz2;
        }

        var trend = zeros(n), seasonals = [], seasonalTotal = zeros(n),
            seasonAdjusted = zeros(n), remainder = zeros(n);
        for (t = 0; t < n; t++) trend[t] = trendAt(xsol, t) * sg + mu;
        for (k = 0; k < K; k++) {
            var comp = zeros(n);
            for (t = 0; t < n; t++) { comp[t] = xsol[SOFF + k * n + t] * sg; seasonalTotal[t] += comp[t]; }
            seasonals.push(comp);
        }
        for (t = 0; t < n; t++) {
            seasonAdjusted[t] = y[t] - seasonalTotal[t];
            remainder[t] = seasonAdjusted[t] - trend[t];
        }
        return { trend: trend, seasonals: seasonals, periods: valid, remainder: remainder,
                 seasonAdjusted: seasonAdjusted, seasonalTotal: seasonalTotal,
                 iterations: iterUsed, converged: converged, knots: nK, lambdaTrend: lTfull };
    }

    function dot(a, b) {
        var s = 0;
        for (var i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
    }

    /**
     * Extrapolate an STR seasonal component. Because STR lets the profile
     * evolve, we take the last cycle and continue the per-phase drift
     * observed between the last two cycles (damped).
     */
    function extendSeasonalSTR(seasonal, period, horizon, damp) {
        var n = seasonal.length, out = zeros(horizon);
        damp = damp == null ? 0.5 : damp;
        var haveTwo = n >= 2 * period;
        for (var h = 0; h < horizon; h++) {
            var back = period - ((h % period) + 1);
            var last = seasonal[n - 1 - back];
            var drift = 0;
            if (haveTwo) {
                var prev = seasonal[n - 1 - back - period];
                drift = (last - prev) * damp * (Math.floor(h / period) + 1);
            }
            out[h] = last + drift;
        }
        return out;
    }

    /* ============================================================
     * 8. N-BEATS (compact interpretable configuration).
     *    Doubly-residual stacks of fully connected blocks; each
     *    block emits a backcast it removes from the residual and a
     *    forecast it adds to the running total. Trend blocks use a
     *    polynomial basis, seasonality blocks a Fourier basis.
     * ========================================================== */

    function constTensor(rows, cols, fill) {
        var t = new Tensor(rows, cols);
        t.noGrad = true;
        for (var i = 0; i < rows; i++) for (var j = 0; j < cols; j++) t.data[i * cols + j] = fill(i, j);
        return t;
    }

    function makeBasis(kind, dim, length) {
        if (kind === 'trend') {
            return constTensor(dim, length, function (j, t) { return Math.pow(t / length, j); });
        }
        if (kind === 'seasonality') {
            var harm = dim / 2;
            return constTensor(dim, length, function (j, t) {
                var i = Math.floor(j / 2) + 1, arg = 2 * Math.PI * i * t / length;
                return j % 2 === 0 ? Math.cos(arg) : Math.sin(arg);
            });
        }
        return constTensor(dim, length, function (j, t) { return j === t ? 1 : 0; });   // generic
    }

    function makeBlock(kind, L, H, width, layers, polyDegree, harmonics, rng) {
        var dimB, dimF;
        if (kind === 'trend') { dimB = polyDegree + 1; dimF = polyDegree + 1; }
        else if (kind === 'seasonality') { dimB = 2 * harmonics; dimF = 2 * harmonics; }
        else { dimB = L; dimF = H; }
        var fc = [], inDim = L;
        for (var l = 0; l < layers; l++) {
            fc.push({ W: param(inDim, width, rng, Math.sqrt(2 / inDim)), b: param(1, width, null) });
            inDim = width;
        }
        return {
            kind: kind, fc: fc,
            Wb: param(width, dimB, rng, Math.sqrt(1 / width)), bb: param(1, dimB, null),
            Wf: param(width, dimF, rng, Math.sqrt(1 / width)), bf: param(1, dimF, null),
            basisB: makeBasis(kind, dimB, L),
            basisF: makeBasis(kind, dimF, H)
        };
    }

    function blockParams(block) {
        var ps = [];
        block.fc.forEach(function (l) { ps.push(l.W, l.b); });
        ps.push(block.Wb, block.bb, block.Wf, block.bf);
        return ps;
    }

    function nbeatsForward(g, blocks, X) {
        var res = X, total = null;
        for (var i = 0; i < blocks.length; i++) {
            var blk = blocks[i], h = res;
            for (var l = 0; l < blk.fc.length; l++) h = g.relu(g.addBias(g.matmul(h, blk.fc[l].W), blk.fc[l].b));
            var thetaB = g.addBias(g.matmul(h, blk.Wb), blk.bb);
            var thetaF = g.addBias(g.matmul(h, blk.Wf), blk.bf);
            var backcast = g.matmul(thetaB, blk.basisB);
            var forecast = g.matmul(thetaF, blk.basisF);
            res = g.sub(res, backcast);
            total = total ? g.add(total, forecast) : forecast;
        }
        return total;
    }

    async function nbeatsFit(x, opts, ctx) {
        opts = opts || {};
        ctx = ctx || {};
        var n = x.length;
        var H = Math.max(1, opts.horizon || 1);
        var L = Math.max(2, Math.min(opts.lookback || 3 * H, Math.max(2, n - H - 1)));
        var width = opts.width || 48;
        var layers = opts.layers || 2;
        var blocksPerStack = opts.blocksPerStack || 1;
        var stackTypes = opts.stacks || ['trend', 'seasonality'];
        var polyDegree = opts.polyDegree || 2;
        var harmonics = Math.max(1, Math.min(opts.harmonics || Math.max(2, Math.floor(H / 2)), 10));
        var epochs = opts.epochs || 100;
        var batchSize = opts.batch || 64;
        var lr = opts.lr || 0.015;
        var rng = opts.rng || mulberry32(opts.seed || 7);

        var nWindows = n - L - H + 1;
        if (nWindows < 8) throw new Error('Not enough history for N-BEATS: need at least lookback + horizon + 8 observations.');

        // Instance normalisation. Each window is centred on its own level, but
        // scaled by a global amplitude with a per-window floor — dividing by a
        // tiny local sd (a flat stretch of a smooth series) blows the targets up.
        var globalSd = sd(x) || 1;
        var scaleFloor = globalSd * (opts.scaleFloor == null ? 0.25 : opts.scaleFloor);
        var centre = opts.centre || 'mean';         // 'mean' | 'last'
        function windowStats(win) {
            var q, s2 = 0;
            for (q = 0; q < win.length; q++) s2 += win[q];
            var mu2 = centre === 'last' ? win[win.length - 1] : s2 / win.length;
            var barr = s2 / win.length, v2 = 0;
            for (q = 0; q < win.length; q++) v2 += (win[q] - barr) * (win[q] - barr);
            var sg2 = Math.sqrt(v2 / Math.max(1, win.length - 1));
            return { mu: mu2, sg: Math.max(sg2, scaleFloor) };
        }

        var Xw = zeros(nWindows * L), Yw = zeros(nWindows * H);
        var mus = zeros(nWindows), sgs = zeros(nWindows);
        for (var i = 0; i < nWindows; i++) {
            var win0 = x.slice ? Array.prototype.slice.call(x, i, i + L) : null;
            if (!win0) { win0 = []; for (var q0 = 0; q0 < L; q0++) win0.push(x[i + q0]); }
            var st0 = windowStats(win0), j;
            mus[i] = st0.mu; sgs[i] = st0.sg;
            for (j = 0; j < L; j++) Xw[i * L + j] = (x[i + j] - st0.mu) / st0.sg;
            for (j = 0; j < H; j++) Yw[i * H + j] = (x[i + L + j] - st0.mu) / st0.sg;
        }

        var nVal = Math.max(1, Math.min(Math.floor(nWindows * (opts.valFrac == null ? 0.15 : opts.valFrac)), nWindows - 4));
        var nTrain = nWindows - nVal;

        var blocks = [], params = [];
        for (var st = 0; st < stackTypes.length; st++)
            for (var bl = 0; bl < blocksPerStack; bl++) {
                var blk = makeBlock(stackTypes[st], L, H, width, layers, polyDegree, harmonics, rng);
                blocks.push(blk);
                params = params.concat(blockParams(blk));
            }

        var opt = new Adam(params, lr);
        var g = new Graph();
        var order = [];
        for (i = 0; i < nTrain; i++) order.push(i);

        var best = Infinity, bestState = null, lossHistory = [], valHistory = [];
        var patience = opts.patience || 25, sinceBest = 0;

        for (var ep = 0; ep < epochs; ep++) {
            // shuffle
            for (i = order.length - 1; i > 0; i--) {
                var r2 = Math.floor(rng() * (i + 1)), tmp = order[i];
                order[i] = order[r2]; order[r2] = tmp;
            }
            var epochLoss = 0, nb = 0;
            for (var start = 0; start < nTrain; start += batchSize) {
                var idx = order.slice(start, start + batchSize), B = idx.length;
                var Xb = new Tensor(B, L), Yb = zeros(B * H);
                Xb.noGrad = true;
                for (i = 0; i < B; i++) {
                    for (j = 0; j < L; j++) Xb.data[i * L + j] = Xw[idx[i] * L + j];
                    for (j = 0; j < H; j++) Yb[i * H + j] = Yw[idx[i] * H + j];
                }
                g.reset(); opt.zeroGrad();
                var pred = nbeatsForward(g, blocks, Xb);
                var loss = g.mse(pred, Yb);
                g.backward(loss);
                opt.step(5);
                epochLoss += loss.data[0]; nb++;
            }
            var vl = nbeatsEvaluate(blocks, Xw, Yw, L, H, nTrain, nWindows).loss;
            lossHistory.push(epochLoss / Math.max(1, nb));
            valHistory.push(vl);
            if (vl < best - 1e-7) { best = vl; bestState = snapshot(params); sinceBest = 0; }
            else if (++sinceBest >= patience) { break; }
            if (ctx.progress) ctx.progress((ep + 1) / epochs, 'Epoch ' + (ep + 1) + '/' + epochs + ' · val MSE ' + vl.toFixed(4));
            if (ctx.yield) await ctx.yield();
        }
        if (bestState) restore(params, bestState);

        // Per-horizon validation errors, on the original scale — these drive the
        // prediction intervals.
        var val = nbeatsEvaluate(blocks, Xw, Yw, L, H, nTrain, nWindows, mus, sgs);

        function predictRaw(window) {                    // window: last L raw observations
            var st1 = windowStats(window), mu2 = st1.mu, sg2 = st1.sg, q;
            var Xb2 = new Tensor(1, L); Xb2.noGrad = true;
            for (q = 0; q < L; q++) Xb2.data[q] = (window[q] - mu2) / sg2;
            var g2 = new Graph();
            var out = nbeatsForward(g2, blocks, Xb2);
            g2.reset();
            var res = zeros(H);
            for (q = 0; q < H; q++) res[q] = out.data[q] * sg2 + mu2;
            return res;
        }

        // one-step-ahead in-sample fit (first element of each window forecast)
        var fitted = new Array(n).fill(NaN);
        for (i = 0; i < nWindows; i++) {
            var win = [];
            for (j = 0; j < L; j++) win.push(x[i + j]);
            fitted[i + L] = predictRaw(win)[0];
        }

        return {
            lookback: L, horizon: H, blocks: blocks.length, width: width,
            stacks: stackTypes, epochsRun: lossHistory.length,
            loss: lossHistory, valLoss: valHistory, valErrorsByStep: val.errorsByStep,
            fitted: fitted, predict: predictRaw,
            nParams: params.reduce(function (a, p) { return a + p.data.length; }, 0)
        };
    }

    function nbeatsEvaluate(blocks, Xw, Yw, L, H, from, to, mus, sgs) {
        var g = new Graph(), count = to - from;
        if (count <= 0) return { loss: 0, errorsByStep: [] };
        var Xb = new Tensor(count, L); Xb.noGrad = true;
        var Yb = zeros(count * H), i, j;
        for (i = 0; i < count; i++) {
            for (j = 0; j < L; j++) Xb.data[i * L + j] = Xw[(from + i) * L + j];
            for (j = 0; j < H; j++) Yb[i * H + j] = Yw[(from + i) * H + j];
        }
        var pred = nbeatsForward(g, blocks, Xb);
        g.reset();
        var s = 0;
        for (i = 0; i < count * H; i++) { var d = pred.data[i] - Yb[i]; s += d * d; }
        var errorsByStep = [];
        if (mus) {
            for (j = 0; j < H; j++) {
                var errs = [];
                for (i = 0; i < count; i++) {
                    var sc = sgs[from + i];
                    errs.push((pred.data[i * H + j] - Yb[i * H + j]) * sc);
                }
                errorsByStep.push(errs);
            }
        }
        return { loss: s / (count * H), errorsByStep: errorsByStep };
    }

    /* ============================================================
     * 9. Accuracy measures, baselines and diagnostics
     * ========================================================== */

    function metrics(actual, pred, scaleDenom) {
        var n = 0, se = 0, ae = 0, ape = 0, sape = 0, i;
        var mAct = mean(actual), sst = 0;
        for (i = 0; i < actual.length; i++) {
            var a = actual[i], p = pred[i];
            if (!isFinite(a) || !isFinite(p)) continue;
            var e = a - p;
            se += e * e; ae += Math.abs(e);
            if (Math.abs(a) > 1e-10) ape += Math.abs(e / a);
            var den = (Math.abs(a) + Math.abs(p)) / 2;
            if (den > 1e-10) sape += Math.abs(e) / den;
            sst += (a - mAct) * (a - mAct);
            n++;
        }
        if (!n) return null;
        return {
            n: n,
            rmse: Math.sqrt(se / n),
            mae: ae / n,
            mape: 100 * ape / n,
            smape: 100 * sape / n,
            r2: sst > 0 ? 1 - se / sst : NaN,
            mase: scaleDenom > 0 ? (ae / n) / scaleDenom : NaN
        };
    }

    /** Mean absolute error of the in-sample seasonal-naive forecast (MASE scale). */
    function naiveScale(y, m) {
        m = Math.max(1, m || 1);
        var s = 0, c = 0;
        for (var i = m; i < y.length; i++) { s += Math.abs(y[i] - y[i - m]); c++; }
        return c ? s / c : 0;
    }

    function seasonalNaive(y, m, h) {
        var out = zeros(h), n = y.length;
        m = Math.max(1, m || 1);
        for (var i = 0; i < h; i++) out[i] = y[n - m + (i % m)];
        return out;
    }

    function acf(resid, maxLag) {
        var r = resid.filter(isFinite), n = r.length, m = mean(r), out = [];
        var denom = 0, i;
        for (i = 0; i < n; i++) denom += (r[i] - m) * (r[i] - m);
        for (var k = 1; k <= maxLag; k++) {
            var s = 0;
            for (i = k; i < n; i++) s += (r[i] - m) * (r[i - k] - m);
            out.push(denom > 0 ? s / denom : 0);
        }
        return { values: out, bound: 1.96 / Math.sqrt(n), n: n };
    }

    /** Ljung-Box test on the residual autocorrelations. */
    function ljungBox(resid, lags) {
        var a = acf(resid, lags), n = a.n, q = 0;
        for (var k = 1; k <= lags; k++) q += a.values[k - 1] * a.values[k - 1] / (n - k);
        q *= n * (n + 2);
        return { statistic: q, df: lags, pValue: 1 - chiSquareCdf(q, lags) };
    }

    function chiSquareCdf(x, k) {
        if (x <= 0) return 0;
        return lowerGamma(k / 2, x / 2);
    }
    /** Regularised lower incomplete gamma P(a, x). */
    function lowerGamma(a, x) {
        if (x < a + 1) {
            var sum = 1 / a, term = sum;
            for (var i = 1; i < 300; i++) {
                term *= x / (a + i);
                sum += term;
                if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
            }
            return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
        }
        // continued fraction for Q(a, x)
        var b = x + 1 - a, c = 1e30, d = 1 / b, hh = d;
        for (var j = 1; j < 300; j++) {
            var an = -j * (j - a);
            b += 2; d = an * d + b; if (Math.abs(d) < 1e-30) d = 1e-30;
            c = b + an / c; if (Math.abs(c) < 1e-30) c = 1e-30;
            d = 1 / d;
            var del = d * c; hh *= del;
            if (Math.abs(del - 1) < 1e-12) break;
        }
        return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * hh;
    }
    function logGamma(z) {
        var g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
                 -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
        var x = z, y = z, tmp = x + 5.5;
        tmp -= (x + 0.5) * Math.log(tmp);
        var ser = 1.000000000190015;
        for (var j = 0; j < 6; j++) ser += g[j] / ++y;
        return -tmp + Math.log(2.5066282746310005 * ser / x);
    }

    /* ============================================================
     * 10. The two published frameworks, end to end
     * ========================================================== */

    async function forecastMSTLNNAR(y, cfg, ctx) {
        ctx = ctx || {};
        var h = cfg.horizon, n = y.length;
        var decomp = mstl(y, cfg.periods, { iterate: cfg.mstlIterate || 2 });
        if (ctx.progress) ctx.progress(0.05, 'MSTL decomposition complete');
        if (ctx.yield) await ctx.yield();

        var sa = decomp.seasonAdjusted;
        var mBig = decomp.periods.length ? decomp.periods[decomp.periods.length - 1] : 1;
        var net = await nnarFit(sa, {
            p: cfg.p, P: cfg.P || 0, m: mBig, size: cfg.size,
            repeats: cfg.repeats, iters: cfg.iters, lr: cfg.lr, decay: cfg.decay,
            seed: cfg.seed
        }, wrapProgress(ctx, 0.05, 0.9));

        var saF = net.forecast(h);
        var seasF = zeros(h), k, i;
        for (k = 0; k < decomp.seasonals.length; k++) {
            var ext = extendSeasonal(decomp.seasonals[k], decomp.periods[k], h);
            for (i = 0; i < h; i++) seasF[i] += ext[i];
        }
        var point = zeros(h);
        for (i = 0; i < h; i++) point[i] = saF[i] + seasF[i];

        var fitted = new Array(n).fill(NaN), residuals = new Array(n).fill(NaN);
        for (i = 0; i < n; i++) {
            if (isFinite(net.fitted[i])) {
                fitted[i] = net.fitted[i] + decomp.seasonalTotal[i];
                residuals[i] = y[i] - fitted[i];
            }
        }

        // Prediction intervals by bootstrapping the residuals through the
        // recursive forecast path.
        var paths = cfg.paths == null ? 200 : cfg.paths;
        var intervals = null;
        if (paths > 0) {
            var prng = mulberry32((cfg.seed || 42) + 991);
            var sims = net.simulate(h, paths, residuals, prng);
            intervals = quantileBands(sims, seasF, cfg.level || 0.95);
        }
        if (ctx.progress) ctx.progress(1, 'Done');
        return {
            model: 'MSTL-NNAR', point: point, intervals: intervals,
            fitted: fitted, residuals: residuals, decomposition: decomp,
            detail: {
                'Seasonal periods': decomp.periods.length ? decomp.periods.join(', ') : 'none detected',
                'NNAR lags': net.lags.join(', '),
                'Hidden units': net.size,
                'Networks averaged': net.repeats,
                'Parameters per network': net.nParams
            }
        };
    }

    async function forecastSTRNBEATS(y, cfg, ctx) {
        ctx = ctx || {};
        var h = cfg.horizon, n = y.length, i, k;
        var decomp = strDecompose(y, cfg.periods, {
            trendWindow: cfg.trendWindow,
            lambdaShape: cfg.lambdaShape,
            lambdaEvolve: cfg.lambdaEvolve
        });
        if (ctx.progress) ctx.progress(0.05, 'STR decomposition converged in ' + decomp.iterations + ' iterations');
        if (ctx.yield) await ctx.yield();

        var sa = decomp.seasonAdjusted;
        // The N-BEATS input is the seasonally adjusted series, so it does not
        // need to span a seasonal cycle. Three times the horizon beat both a
        // shorter window and a full-period one across the test series.
        var lookback = cfg.lookback || Math.max(8, Math.min(3 * h, Math.floor(n / 3)));
        var nb = await nbeatsFit(sa, {
            horizon: h, lookback: lookback, width: cfg.width, layers: cfg.layers,
            blocksPerStack: cfg.blocksPerStack, stacks: cfg.stacks,
            polyDegree: cfg.polyDegree, harmonics: cfg.harmonics,
            epochs: cfg.epochs, batch: cfg.batch, lr: cfg.nbLr, seed: cfg.seed
        }, wrapProgress(ctx, 0.05, 0.95));

        var lastWindow = [];
        for (i = sa.length - nb.lookback; i < sa.length; i++) lastWindow.push(sa[i]);
        var saF = nb.predict(lastWindow);

        var seasF = zeros(h);
        for (k = 0; k < decomp.seasonals.length; k++) {
            var ext = extendSeasonalSTR(decomp.seasonals[k], decomp.periods[k], h, cfg.seasonalCycles, cfg.seasonalDecay);
            for (i = 0; i < h; i++) seasF[i] += ext[i];
        }
        var point = zeros(h);
        for (i = 0; i < h; i++) point[i] = saF[i] + seasF[i];

        var fitted = new Array(n).fill(NaN), residuals = new Array(n).fill(NaN);
        for (i = 0; i < n; i++) {
            if (isFinite(nb.fitted[i])) {
                fitted[i] = nb.fitted[i] + decomp.seasonalTotal[i];
                residuals[i] = y[i] - fitted[i];
            }
        }

        // Intervals from the empirical distribution of validation errors at
        // each forecast step (a direct multi-horizon model gives these for free).
        var intervals = null;
        if (nb.valErrorsByStep && nb.valErrorsByStep.length === h) {
            var level = cfg.level || 0.95, lo = (1 - level) / 2, hi = 1 - lo;
            var loArr = zeros(h), hiArr = zeros(h);
            for (i = 0; i < h; i++) {
                var errs = nb.valErrorsByStep[i].slice().sort(function (a, b) { return a - b; });
                loArr[i] = point[i] + quantile(errs, lo);
                hiArr[i] = point[i] + quantile(errs, hi);
            }
            intervals = { lower: loArr, upper: hiArr, level: level };
        }
        if (ctx.progress) ctx.progress(1, 'Done');
        return {
            model: 'STR-NBEATS', point: point, intervals: intervals,
            fitted: fitted, residuals: residuals, decomposition: decomp,
            detail: {
                'Seasonal periods': decomp.periods.length ? decomp.periods.join(', ') : 'none detected',
                'STR CG iterations': decomp.iterations,
                'Lookback window': nb.lookback,
                'Stacks': nb.stacks.join(' + '),
                'Blocks': nb.blocks,
                'Hidden width': nb.width,
                'Epochs run': nb.epochsRun,
                'Trainable parameters': nb.nParams
            }
        };
    }

    function quantileBands(sims, seasF, level) {
        var h = sims[0].length, lo = (1 - level) / 2, hi = 1 - lo;
        var loArr = zeros(h), hiArr = zeros(h);
        for (var i = 0; i < h; i++) {
            var col = [];
            for (var s = 0; s < sims.length; s++) col.push(sims[s][i] + (seasF ? seasF[i] : 0));
            col.sort(function (a, b) { return a - b; });
            loArr[i] = quantile(col, lo);
            hiArr[i] = quantile(col, hi);
        }
        return { lower: loArr, upper: hiArr, level: level };
    }

    function wrapProgress(ctx, from, to) {
        return {
            yield: ctx.yield,
            progress: function (frac, label) {
                if (ctx.progress) ctx.progress(from + (to - from) * Math.max(0, Math.min(1, frac)), label);
            }
        };
    }

    var MODELS = {
        'mstl-nnar': { label: 'MSTL-NNAR', run: forecastMSTLNNAR },
        'str-nbeats': { label: 'STR-NBEATS', run: forecastSTRNBEATS }
    };

    /**
     * Full pipeline: optional hold-out evaluation, then a refit on all the
     * data for the forecast the user actually takes away.
     */
    async function runModel(y, cfg, ctx) {
        ctx = ctx || {};
        var series = interpolateGaps(y);
        var n = series.length;
        var spec = MODELS[cfg.model];
        if (!spec) throw new Error('Unknown model: ' + cfg.model);
        // The benchmark and the MASE denominator use the SHORTEST seasonal
        // cycle — "the same hour yesterday", "the same month last year". Using
        // the longest one would compare a one-week forecast against a value
        // from a year ago, which is not the rule a practitioner would reach for.
        var mBase = 0;
        (cfg.periods || []).forEach(function (p) {
            if (p >= 2 && n >= 2 * p) mBase = mBase ? Math.min(mBase, Math.round(p)) : Math.round(p);
        });
        if (!mBase) mBase = 1;

        var out = { model: spec.label, key: cfg.model, horizon: cfg.horizon, periods: cfg.periods };
        var t0 = Date.now();

        if (cfg.testSize > 0) {
            var cut = n - cfg.testSize;
            if (cut < Math.max(20, 2 * (cfg.periods[0] || 4))) throw new Error('Hold-out is too large for this series.');
            var train = series.slice(0, cut), test = series.slice(cut);
            var evalCfg = Object.assign({}, cfg, { horizon: cfg.testSize, paths: Math.min(cfg.paths || 200, 120) });
            var ev = await spec.run(train, evalCfg, wrapProgress(ctx, 0, cfg.horizon ? 0.5 : 1));
            var denom = naiveScale(train, mBase);
            out.evaluation = {
                testSize: cfg.testSize,
                actual: Array.from(test),
                predicted: Array.from(ev.point),
                startIndex: cut,
                metrics: metrics(test, ev.point, denom),
                baseline: {
                    label: mBase > 1 ? 'Seasonal naive (m = ' + mBase + ')' : 'Naive (last value)',
                    predicted: Array.from(seasonalNaive(train, mBase, cfg.testSize)),
                    metrics: metrics(test, seasonalNaive(train, mBase, cfg.testSize), denom)
                }
            };
        }

        var full = await spec.run(series, cfg, wrapProgress(ctx, out.evaluation ? 0.5 : 0, 1));
        out.point = Array.from(full.point);
        out.intervals = full.intervals ? {
            lower: Array.from(full.intervals.lower),
            upper: Array.from(full.intervals.upper),
            level: full.intervals.level
        } : null;
        out.fitted = full.fitted;
        out.residuals = full.residuals;
        out.detail = full.detail;
        out.decomposition = {
            trend: Array.from(full.decomposition.trend),
            seasonals: full.decomposition.seasonals.map(function (s) { return Array.from(s); }),
            periods: full.decomposition.periods,
            remainder: Array.from(full.decomposition.remainder),
            seasonAdjusted: Array.from(full.decomposition.seasonAdjusted)
        };
        var res = full.residuals.filter(isFinite);
        out.insample = metrics(
            series.filter(function (_, i) { return isFinite(full.fitted[i]); }),
            full.fitted.filter(isFinite),
            naiveScale(series, mBase)
        );
        out.acf = acf(full.residuals, Math.min(36, Math.max(10, Math.round(mBase * 1.5))));
        out.ljungBox = res.length > 20 ? ljungBox(full.residuals, Math.min(20, Math.floor(res.length / 5))) : null;
        out.residualSd = sd(res);
        out.elapsedMs = Date.now() - t0;
        return out;
    }

    /* ============================================================
     * 11. Seasonality helpers used by the UI
     * ========================================================== */

    /** Candidate seasonal periods implied by a detected sampling frequency. */
    var FREQ_PERIODS = {
        hourly: [24, 168],
        halfhourly: [48, 336],
        daily: [7, 365],
        weekly: [52],
        monthly: [12],
        quarterly: [4],
        yearly: [],
        unknown: []
    };

    /**
     * Strength of seasonality at period m: 1 - Var(remainder)/Var(remainder+seasonal),
     * the Wang-Smith-Hyndman measure. Used to rank candidate periods.
     */
    function seasonalStrength(y, m) {
        if (y.length < 2 * m || m < 2) return 0;
        var d = stl(interpolateGaps(y), m, { inner: 1 });
        var rs = [], both = [];
        for (var i = 0; i < y.length; i++) { rs.push(d.remainder[i]); both.push(d.remainder[i] + d.seasonal[i]); }
        var vr = variance(rs), vb = variance(both);
        if (vb <= 0) return 0;
        return Math.max(0, Math.min(1, 1 - vr / vb));
    }
    function variance(a) { var m = mean(a), s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return s / Math.max(1, a.length - 1); }

    /**
     * Choose which seasonal periods to model, one at a time.
     *
     * Testing each candidate against the raw series picks up harmonics: a pure
     * 12-period cycle also looks strongly "seasonal" at 24. So each period is
     * accepted on its *incremental* strength — the seasonality still present
     * once everything already chosen has been removed.
     */
    function detectSeasonalPeriods(y, candidates, opts) {
        opts = opts || {};
        // The first period has to be clearly seasonal; once a dominant cycle is
        // out of the way a much weaker residual cycle is usually real rather
        // than noise, and including it measurably improves forecasts.
        //
        // Both bars are lifted by the strength a period of that length would
        // reach on pure noise. A seasonal component of period m fits m free
        // parameters to n points, so it explains roughly m/n of the variance by
        // chance alone: without this correction a long period tested on a short
        // series always looks seasonal, and every harmonic of a real cycle
        // sneaks in behind it.
        var threshold = opts.threshold == null ? 0.3 : opts.threshold;
        var extraThreshold = opts.extraThreshold == null ? 0.06 : opts.extraThreshold;
        var chanceFactor = opts.chanceFactor == null ? 2 : opts.chanceFactor;
        var maxPeriods = opts.maxPeriods || 3;
        var series = interpolateGaps(y);
        var pool = (candidates || [])
            .map(function (p) { return Math.round(p); })
            .filter(function (p) { return p >= 2 && series.length >= 2 * p; })
            .sort(function (a, b) { return a - b; })
            .filter(function (p, i, a) { return i === 0 || p !== a[i - 1]; });

        var report = pool.map(function (m) {
            return { period: m, strength: seasonalStrength(series, m), selected: false };
        });
        var byPeriod = {};
        report.forEach(function (r) { byPeriod[r.period] = r; });

        // Sweep the candidates shortest-first and accept one at a time, always
        // measuring against the series with the already-accepted seasonality
        // removed. Sweeping repeatedly matters: a weekly cycle can look weak
        // next to a yearly one and only clear the bar once the year is out.
        var selected = [], work = series, remaining = pool.slice(), changed = true;
        while (changed && selected.length < maxPeriods && remaining.length) {
            changed = false;
            for (var i = 0; i < remaining.length; i++) {
                var m = remaining[i];
                var st = selected.length ? seasonalStrength(work, m) : byPeriod[m].strength;
                var chance = chanceFactor * m / series.length;
                var bar = Math.max(selected.length ? extraThreshold : threshold, chance);
                byPeriod[m].bar = bar;
                if (st < bar) continue;
                selected.push(m);
                byPeriod[m].selected = true;
                byPeriod[m].incremental = st;
                remaining.splice(i, 1);
                selected.sort(function (a, b) { return a - b; });
                if (remaining.length && selected.length < maxPeriods)
                    work = mstl(series, selected).seasonAdjusted;
                changed = true;
                break;
            }
        }
        return { selected: selected, candidates: report };
    }

    return {
        version: '1.0.0',
        mulberry32: mulberry32, mean: mean, sd: sd, quantile: quantile,
        interpolateGaps: interpolateGaps, loess: loess, movingAverage: movingAverage,
        stl: stl, mstl: mstl, strDecompose: strDecompose,
        extendSeasonal: extendSeasonal, extendSeasonalSTR: extendSeasonalSTR,
        nnarFit: nnarFit, nbeatsFit: nbeatsFit,
        forecastMSTLNNAR: forecastMSTLNNAR, forecastSTRNBEATS: forecastSTRNBEATS,
        runModel: runModel, metrics: metrics, acf: acf, ljungBox: ljungBox,
        seasonalNaive: seasonalNaive, naiveScale: naiveScale,
        seasonalStrength: seasonalStrength, detectSeasonalPeriods: detectSeasonalPeriods,
        FREQ_PERIODS: FREQ_PERIODS,
        MODELS: MODELS
    };
});
