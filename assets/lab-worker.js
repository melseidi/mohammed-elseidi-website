/*!
 * Forecast Lab worker — keeps model training off the UI thread.
 * All computation happens here, in the visitor's own browser.
 */
importScripts('lab-core.js');

var ctxFor = function (id) {
    var last = 0;
    return {
        progress: function (frac, label) {
            var now = Date.now();
            if (now - last < 80 && frac < 1) return;      // don't flood the main thread
            last = now;
            self.postMessage({ type: 'progress', id: id, frac: frac, label: label });
        },
        yield: null
    };
};

self.onmessage = async function (e) {
    var msg = e.data || {};
    try {
        if (msg.type === 'run') {
            var result = await self.LabCore.runModel(msg.series, msg.cfg, ctxFor(msg.id));
            self.postMessage({ type: 'result', id: msg.id, result: result });
        } else if (msg.type === 'detect') {
            var found = self.LabCore.detectSeasonalPeriods(msg.series, msg.candidates);
            self.postMessage({ type: 'detected', id: msg.id, result: found });
        }
    } catch (err) {
        self.postMessage({ type: 'error', id: msg.id, message: err && err.message ? err.message : String(err) });
    }
};
