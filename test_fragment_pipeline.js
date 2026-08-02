// Run with: node test_fragment_pipeline.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const recorderPath = path.join(__dirname, 'catch-script', 'recorder.js');
const bootstrapPath = path.join(__dirname, 'js', 'fragment-pipeline-bootstrap.js');
const manifestPath = path.join(__dirname, 'manifest.json');

const recorderSource = fs.readFileSync(recorderPath, 'utf8');
const bootstrapSource = fs.readFileSync(bootstrapPath, 'utf8');

// Parse the complete browser scripts without executing DOM/browser APIs.
new Function(recorderSource);
new Function(bootstrapSource);

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

assert.strictEqual(core.sanitizeFileName(' bad:/name?  '), 'bad__name_');
assert.strictEqual(core.clampNumber('9', 1, 6, 2), 6);
assert.strictEqual(core.clampNumber('nope', 1, 6, 2), 2);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
assert.ok(scripts.includes('js/fragment-pipeline-bootstrap.js'), 'worker bootstrap is not registered');
const exposed = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []);
assert.ok(exposed.includes('catch-script/recorder.js'), 'recorder is not exposed to worker tabs');
assert.ok(exposed.includes('catch-script/i18n.js'), 'recorder i18n dependency is not exposed');

console.log('fragment pipeline: ok');
