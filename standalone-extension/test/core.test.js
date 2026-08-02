'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Core = require('../core.js');
const Strategy = require('../sweep-strategy.js');

assert.deepStrictEqual(Core.makeSeekPositions(0, 23, 8), [0, 8, 16, 22.75]);
assert.strictEqual(Core.sanitizeFileName(' bad:/name?  '), 'bad__name_');
assert.deepStrictEqual(Core.parseRange('bytes=100-299'), { start: 100, end: 299 });
assert.strictEqual(Core.classifyResource({ url: 'https://x.test/master.m3u8' }), 'hls');
assert.strictEqual(Core.classifyResource({ url: 'https://x.test/a.mp4', range: 'bytes=0-100' }), 'range');

const master = Core.parseHls(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360,AUDIO="aud"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000,RESOLUTION=1920x1080
high.m3u8`, 'https://cdn.test/path/master.m3u8');
assert.strictEqual(master.isMaster, true);
assert.strictEqual(Core.chooseHlsVariant(master).url, 'https://cdn.test/path/high.m3u8');

const media = Core.parseHls(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
seg-7.m4s
#EXT-X-BYTERANGE:100@20
#EXTINF:4,
blob.bin
#EXT-X-ENDLIST`, 'https://cdn.test/v/index.m3u8');
assert.strictEqual(media.segments.length, 2);
assert.strictEqual(media.segments[0].sequence, 7);
assert.strictEqual(media.segments[0].map.url, 'https://cdn.test/v/init.mp4');
assert.deepStrictEqual(media.segments[1].range, { start: 20, end: 119, length: 100 });
assert.strictEqual(media.segments[0].key.url, 'https://cdn.test/v/key.bin');
assert.strictEqual(media.endList, true);

const sorted = Core.sortCaptured([
  { url: 'https://x.test/2.ts', bucket: 2, timeStamp: 1 },
  { url: 'https://x.test/1.ts', bucket: 1, timeStamp: 2 },
  { url: 'https://x.test/1.ts', bucket: 1, timeStamp: 3 },
]);
assert.deepStrictEqual(sorted.map((item) => item.url), ['https://x.test/1.ts', 'https://x.test/2.ts']);

const groups = Core.groupRawResources([
  { url: 'https://x.test/v/a.ts', bucket: 0, kind: 'segment' },
  { url: 'https://x.test/v/b.ts', bucket: 1, kind: 'segment' },
  { url: 'https://x.test/a/a.aac', bucket: 0, kind: 'segment' },
]);
assert.strictEqual(groups[0].items.length, 2);

const merged = Core.dedupeResources([
  { url: 'https://x.test/blob', timeStamp: 1, kind: 'other', synthetic: true },
  { url: 'https://x.test/blob', timeStamp: 2, kind: 'segment', contentType: 'application/octet-stream' },
]);
assert.strictEqual(merged[0].kind, 'segment');

assert.strictEqual(Strategy.bufferedEnd([{ start: 0, end: 31.5 }], 8), 31.5);
assert.deepStrictEqual(
  Strategy.nextPosition({ cursor: 8, edge: 31.5, end: 100, fallbackStep: 8, stalls: 0 }),
  { done: false, position: 31.42, usedBuffer: true },
);
assert.strictEqual(
  Strategy.nextPosition({ cursor: 99.8, edge: 100, end: 100, fallbackStep: 8, stalls: 0 }).done,
  true,
);
assert.strictEqual(Strategy.progress(10, 110, 60), 0.5);

const sources = {};
for (const file of ['service-worker.js', 'content-script.js', 'popup.js', 'assembler.js', 'sweep-strategy.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  sources[file] = source;
  new Function(source);
}

assert.match(sources['content-script.js'], /Strategy\.bufferedEnd/, 'sweep must follow buffered ranges');
assert.match(sources['content-script.js'], /seenPerformance/, 'resource timing entries must be sent only once');
assert.doesNotMatch(sources['content-script.js'], /makeSeekPositions\(/, 'fixed interval sweep must not be the primary path');

assert.match(sources['service-worker.js'], /case 'SAVE_OUTPUT'/, 'background download entrypoint is missing');
assert.match(sources['service-worker.js'], /case 'GET_DOWNLOAD_STATUS'/, 'download status endpoint is missing');
assert.match(sources['service-worker.js'], /chrome\.downloads\.download\(/, 'service worker must own chrome.downloads');
assert.match(
  sources['service-worker.js'],
  /if \(message\.ok\) await chrome\.storage\.local\.remove\(`captureJob:\$\{message\.jobId\}`\)/,
  'failed assembly jobs must remain retryable',
);
assert.doesNotMatch(
  sources['assembler.js'],
  /chrome\.downloads\.download\(/,
  'assembler must not bypass the service-worker download boundary',
);
assert.match(sources['assembler.js'], /type: 'SAVE_OUTPUT'/, 'assembler must request a background save');
assert.match(sources['assembler.js'], /type: 'GET_DOWNLOAD_STATUS'/, 'assembler must wait for the real download state');
assert.match(sources['assembler.js'], /response\.state === 'complete'/, 'assembly must not report success before download completion');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.background.service_worker, 'service-worker.js');
assert.deepStrictEqual(
  manifest.content_scripts[0].js,
  ['core.js', 'sweep-strategy.js', 'content-script.js'],
);
console.log('seek fragment core: ok');