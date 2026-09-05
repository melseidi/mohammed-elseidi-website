/*!
 * Forecast Lab charts — small canvas plotting layer.
 * Line charts with interval bands and a crosshair tooltip, plus the ACF
 * bar chart used for residual diagnostics. No external dependencies.
 */
(function (root) {
    'use strict';

    var INK = '#0f172a', MUTED = '#6b7383', GRID = '#e8e4dc', SURFACE = '#ffffff';

    function dpr() { return Math.max(1, Math.min(3, root.devicePixelRatio || 1)); }

    function niceTicks(min, max, count) {
        if (!isFinite(min) || !isFinite(max)) return [0];
        if (min === max) { min -= 1; max += 1; }
        var span = max - min;
        var step = Math.pow(10, Math.floor(Math.log10(span / count)));
        var err = span / count / step;
        if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
        var start = Math.ceil(min / step) * step, out = [];
        for (var v = start; v <= max + step * 0.001; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
        return out;
    }

    function fmtNum(v) {
        if (!isFinite(v)) return '—';
        var a = Math.abs(v);
        if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
        if (a >= 1e4) return Math.round(v).toLocaleString();
        if (a >= 100) return v.toFixed(1);
        if (a >= 1) return v.toFixed(2);
        if (a === 0) return '0';
        return v.toPrecision(3);
    }

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Object} spec  {x, series, bands, marker, yLabel, height}
     */
    function lineChart(canvas, spec) {
        var wrap = canvas.parentNode;
        var tip = wrap.querySelector('.chart-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'chart-tip';
            tip.setAttribute('role', 'status');
            wrap.appendChild(tip);
        }
        var state = { hover: -1 };
        var geom = null;

        function layout() {
            var w = canvas.clientWidth || wrap.clientWidth || 600;
            var h = spec.height || 320;
            var r = dpr();
            canvas.width = Math.round(w * r);
            canvas.height = Math.round(h * r);
            canvas.style.height = h + 'px';
            var ctx = canvas.getContext('2d');
            ctx.setTransform(r, 0, 0, r, 0, 0);
            return { ctx: ctx, w: w, h: h };
        }

        function draw() {
            var L = layout(), ctx = L.ctx, w = L.w, h = L.h;
            ctx.clearRect(0, 0, w, h);

            var n = spec.x.length;
            var padL = 58, padR = 34, padT = 14, padB = 30;
            var plotW = Math.max(10, w - padL - padR), plotH = Math.max(10, h - padT - padB);

            // y range across every visible series and band
            var min = Infinity, max = -Infinity, i, j;
            function scan(arr) {
                for (var k = 0; k < arr.length; k++) {
                    var v = arr[k];
                    if (v == null || !isFinite(v)) continue;
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
            }
            (spec.bands || []).forEach(function (b) { scan(b.lower); scan(b.upper); });
            (spec.series || []).forEach(function (s) { if (!s.hidden) scan(s.data); });
            if (!isFinite(min)) { min = 0; max = 1; }
            var pad = (max - min) * 0.08 || 1;
            min -= pad; max += pad;

            var xAt = function (i2) { return padL + (n <= 1 ? plotW / 2 : plotW * i2 / (n - 1)); };
            var yAt = function (v) { return padT + plotH * (1 - (v - min) / (max - min)); };
            geom = { xAt: xAt, yAt: yAt, padL: padL, padT: padT, plotW: plotW, plotH: plotH, n: n };

            // grid + y axis
            var ticks = niceTicks(min, max, 5);
            ctx.font = '11px "JetBrains Mono", ui-monospace, Menlo, monospace';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'right';
            ctx.strokeStyle = GRID;
            ctx.lineWidth = 1;
            ticks.forEach(function (t) {
                var y = Math.round(yAt(t)) + 0.5;
                if (y < padT - 1 || y > padT + plotH + 1) return;
                ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
                ctx.fillStyle = MUTED;
                ctx.fillText(fmtNum(t), padL - 8, y);
            });

            // x labels
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            var labelCount = Math.max(2, Math.min(7, Math.floor(plotW / 100)));
            for (i = 0; i < labelCount; i++) {
                var idx = Math.round((n - 1) * i / (labelCount - 1));
                var text = String(spec.x[idx]);
                var half = ctx.measureText(text).width / 2 + 2;
                var lx = Math.max(half, Math.min(w - half, xAt(idx)));
                ctx.fillStyle = MUTED;
                ctx.fillText(text, lx, padT + plotH + 8);
            }

            // interval bands
            (spec.bands || []).forEach(function (b) {
                ctx.beginPath();
                var started = false;
                for (i = 0; i < n; i++) {
                    if (b.upper[i] == null || !isFinite(b.upper[i])) continue;
                    if (!started) { ctx.moveTo(xAt(i), yAt(b.upper[i])); started = true; }
                    else ctx.lineTo(xAt(i), yAt(b.upper[i]));
                }
                for (i = n - 1; i >= 0; i--) {
                    if (b.lower[i] == null || !isFinite(b.lower[i])) continue;
                    ctx.lineTo(xAt(i), yAt(b.lower[i]));
                }
                ctx.closePath();
                ctx.fillStyle = b.color;
                ctx.fill();
            });

            // forecast-origin rule
            if (spec.marker != null && spec.marker >= 0 && spec.marker < n) {
                var mx = Math.round(xAt(spec.marker)) + 0.5;
                ctx.save();
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = '#94a3b8';
                ctx.beginPath(); ctx.moveTo(mx, padT); ctx.lineTo(mx, padT + plotH); ctx.stroke();
                ctx.restore();
                if (spec.markerLabel) {
                    ctx.save();
                    ctx.font = '10px "JetBrains Mono", ui-monospace, Menlo, monospace';
                    ctx.fillStyle = '#94a3b8';
                    ctx.textAlign = mx > padL + plotW * 0.7 ? 'right' : 'left';
                    ctx.textBaseline = 'top';
                    ctx.fillText(spec.markerLabel, mx + (ctx.textAlign === 'right' ? -6 : 6), padT + 2);
                    ctx.restore();
                }
            }

            // series
            (spec.series || []).forEach(function (s) {
                if (s.hidden) return;
                ctx.save();
                ctx.strokeStyle = s.color;
                ctx.lineWidth = s.width || 2;
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                if (s.dash) ctx.setLineDash(s.dash);
                ctx.beginPath();
                var pen = false, drawn = 0;
                for (i = 0; i < n; i++) {
                    var v = s.data[i];
                    if (v == null || !isFinite(v)) { pen = false; continue; }
                    var px = xAt(i), py = yAt(v);
                    if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
                    drawn++;
                }
                ctx.stroke();
                // a single visible point still deserves a mark
                if (drawn === 1) {
                    for (i = 0; i < n; i++) if (s.data[i] != null && isFinite(s.data[i])) {
                        ctx.fillStyle = s.color;
                        ctx.beginPath(); ctx.arc(xAt(i), yAt(s.data[i]), 3, 0, 2 * Math.PI); ctx.fill();
                    }
                }
                ctx.restore();
            });

            // crosshair
            if (state.hover >= 0 && state.hover < n) {
                var hx = Math.round(xAt(state.hover)) + 0.5;
                ctx.save();
                ctx.strokeStyle = '#cbd5e1';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + plotH); ctx.stroke();
                (spec.series || []).forEach(function (s) {
                    if (s.hidden) return;
                    var v = s.data[state.hover];
                    if (v == null || !isFinite(v)) return;
                    ctx.beginPath();
                    ctx.arc(hx, yAt(v), 4, 0, 2 * Math.PI);
                    ctx.fillStyle = s.color;
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = SURFACE;
                    ctx.stroke();
                });
                ctx.restore();
            }
        }

        function showTip(clientX) {
            if (!geom) return;
            var rect = canvas.getBoundingClientRect();
            var rel = clientX - rect.left;
            var i = Math.round((rel - geom.padL) / (geom.plotW || 1) * (geom.n - 1));
            i = Math.max(0, Math.min(geom.n - 1, i));
            state.hover = i;
            draw();
            var rows = '<div class="tip-x">' + spec.x[i] + '</div>';
            var any = false;
            (spec.series || []).forEach(function (s) {
                if (s.hidden) return;
                var v = s.data[i];
                if (v == null || !isFinite(v)) return;
                any = true;
                rows += '<div class="tip-row"><span class="tip-dot" style="background:' + s.color + '"></span>' +
                        '<span class="tip-name">' + s.name + '</span><span class="tip-val">' + fmtNum(v) + '</span></div>';
            });
            (spec.bands || []).forEach(function (b) {
                if (b.lower[i] == null || !isFinite(b.lower[i])) return;
                any = true;
                rows += '<div class="tip-row tip-band"><span class="tip-name">' + b.name + '</span>' +
                        '<span class="tip-val">' + fmtNum(b.lower[i]) + ' – ' + fmtNum(b.upper[i]) + '</span></div>';
            });
            if (!any) { tip.classList.remove('visible'); return; }
            tip.innerHTML = rows;
            tip.classList.add('visible');
            var tw = tip.offsetWidth, x = geom.xAt(i);
            tip.style.left = Math.max(4, Math.min(rect.width - tw - 4, x - tw / 2)) + 'px';
            tip.style.top = '8px';
        }

        function onMove(e) { showTip(e.clientX); }
        function onLeave() { state.hover = -1; tip.classList.remove('visible'); draw(); }
        function onTouch(e) { if (e.touches && e.touches[0]) { showTip(e.touches[0].clientX); } }

        canvas.addEventListener('mousemove', onMove);
        canvas.addEventListener('mouseleave', onLeave);
        canvas.addEventListener('touchstart', onTouch, { passive: true });
        canvas.addEventListener('touchmove', onTouch, { passive: true });

        var ro = null;
        if (root.ResizeObserver) {
            ro = new ResizeObserver(function () { draw(); });
            ro.observe(wrap);
        } else {
            root.addEventListener('resize', draw);
        }
        draw();

        return {
            redraw: draw,
            setSeriesHidden: function (name, hidden) {
                (spec.series || []).forEach(function (s) { if (s.name === name) s.hidden = hidden; });
                draw();
            },
            destroy: function () {
                canvas.removeEventListener('mousemove', onMove);
                canvas.removeEventListener('mouseleave', onLeave);
                if (ro) ro.disconnect(); else root.removeEventListener('resize', draw);
                tip.classList.remove('visible');
            }
        };
    }

    /** ACF bar chart with the +/- 1.96/sqrt(n) significance band. */
    function acfChart(canvas, values, bound, color) {
        var wrap = canvas.parentNode;
        function draw() {
            var w = canvas.clientWidth || wrap.clientWidth || 400, h = 180, r = dpr();
            canvas.width = Math.round(w * r); canvas.height = Math.round(h * r);
            canvas.style.height = h + 'px';
            var ctx = canvas.getContext('2d');
            ctx.setTransform(r, 0, 0, r, 0, 0);
            ctx.clearRect(0, 0, w, h);
            var padL = 40, padR = 10, padT = 12, padB = 24;
            var plotW = w - padL - padR, plotH = h - padT - padB;
            var maxAbs = Math.max(bound * 1.6, 0.2);
            values.forEach(function (v) { maxAbs = Math.max(maxAbs, Math.abs(v) * 1.15); });
            var yAt = function (v) { return padT + plotH * (1 - (v + maxAbs) / (2 * maxAbs)); };

            ctx.font = '11px "JetBrains Mono", ui-monospace, Menlo, monospace';
            ctx.fillStyle = MUTED; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            [-maxAbs / 2, 0, maxAbs / 2].forEach(function (t) {
                var y = Math.round(yAt(t)) + 0.5;
                ctx.strokeStyle = GRID; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
                ctx.fillStyle = MUTED; ctx.fillText(t.toFixed(2), padL - 6, y);
            });
            // significance band
            ctx.fillStyle = 'rgba(148,163,184,0.18)';
            ctx.fillRect(padL, yAt(bound), plotW, yAt(-bound) - yAt(bound));

            var bw = Math.max(2, Math.min(10, plotW / values.length - 2));
            values.forEach(function (v, i) {
                var x = padL + plotW * (i + 0.5) / values.length;
                var y0 = yAt(0), y1 = yAt(v);
                ctx.fillStyle = Math.abs(v) > bound ? '#eb6834' : color;
                ctx.fillRect(x - bw / 2, Math.min(y0, y1), bw, Math.max(1.5, Math.abs(y1 - y0)));
            });
            ctx.strokeStyle = '#cbd5e1';
            ctx.beginPath();
            ctx.moveTo(padL, Math.round(yAt(0)) + 0.5); ctx.lineTo(padL + plotW, Math.round(yAt(0)) + 0.5);
            ctx.stroke();

            ctx.fillStyle = MUTED; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            [1, Math.round(values.length / 2), values.length].forEach(function (lag) {
                var x = padL + plotW * (lag - 0.5) / values.length;
                ctx.fillText('lag ' + lag, x, padT + plotH + 6);
            });
        }
        if (root.ResizeObserver) new ResizeObserver(draw).observe(wrap); else root.addEventListener('resize', draw);
        draw();
        return { redraw: draw };
    }

    root.LabCharts = { lineChart: lineChart, acfChart: acfChart, fmtNum: fmtNum, niceTicks: niceTicks };
})(window);
