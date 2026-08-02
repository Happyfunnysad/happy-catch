// Run with: node test_fragment_pipeline.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const recorderPath = path.join(__dirname, 'catch-script', 'recorder.js');
const recorderSource = fs.readFileSync(recorderPath, 'utf8');

// Parse the complete browser script without executing DOM/browser APIs.
new Function(recorderSource);

const startMarker = '// PIPELINE_CORE_START';
const endMarker = '// PIPELINE_CORE_END';
const start = recorderSource.indexOf(startMarker);
const end = recorderSource.indexOf(endMarker);
assert.ok(start >= 0 && end > start, 'pipeline core markers are missing');

const coreSource = recorderSource.slice(start + startMarker.length, end);
const loadCore = new Function(
    'MediaRecorder',
    `${coreSource}\nreturn { buildRanges, distributeRanges, sanitizeFileName, clampNumber };`,
);
const core = loadCore({ isTypeSupported: () => true });

assert.deepStrictEqual(
    core.buildRanges(0, 305, 120),
    [
        { index: 0, start: 0, end: 120 },
        { index: 1, start: 120, end: 240 },
        { index: 2, start: 240, end: 305 },
    ],
    'ranges must cover the requested interval without gaps',
);

assert.deepStrictEqual(
    core.distributeRanges(core.buildRanges(0, 400, 100), 2).map((items) => items.map((item) => item.index)),
    [[0, 2], [1, 3]],
    'ranges must be distributed deterministically between workers',
);

assert.deepStrictEqual(
    core.distributeRanges(core.buildRanges(0, 300, 100), 5).map((items) => items.map((item) => item.index)),
    [[0], [1], [2], [], []],
    'extra workers must receive empty deterministic queues',
);

assert.strictEqual(core.sanitizeFileName(' bad:/name?  '), 'bad__name_');
assert.strictEqual(core.clampNumber('9', 1, 6, 2), 6);
assert.strictEqual(core.clampNumber('nope', 1, 6, 2), 2);

assert.match(recorderSource, /Promise\.allSettled/, 'worker queues must run concurrently');
assert.match(recorderSource, /const missing = ranges\.filter/, 'missing remote fragments need a local fallback');
assert.match(recorderSource, /concatOrder/, 'ordered FFmpeg merge metadata is missing');
assert.match(recorderSource, /catCatchCloseScript/, 'closing the panel must release Cat Catch script state');
assert.doesNotMatch(
    recorderSource,
    /const current = mediaElements\(\);\s*fillMedia\(panel, current\)/,
    'start must not overwrite the selected media or time range',
);
assert.match(
    recorderSource,
    /!list\.length && window\.top !== window/,
    'empty child frames must not create duplicate panels',
);

console.log('fragment pipeline: ok');
