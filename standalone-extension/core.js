(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SeekFragmentCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MEDIA_EXTENSIONS = new Set([
    'm3u8', 'm3u', 'mpd', 'ts', 'm2ts', 'm4s', 'mp4', 'webm', 'aac', 'm4a', 'mp3',
    'cmfv', 'cmfa', 'fmp4', 'vtt', 'key',
  ]);

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function sanitizeFileName(value) {
    return String(value || 'video')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
      .slice(0, 150) || 'video';
  }

  function getExtension(url) {
    try {
      const pathname = new URL(url).pathname;
      const name = pathname.split('/').pop() || '';
      const dot = name.lastIndexOf('.');
      return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
    } catch (_) {
      return '';
    }
  }

  function headerValue(headers, name) {
    if (!Array.isArray(headers)) return '';
    const found = headers.find((item) => String(item.name || '').toLowerCase() === name.toLowerCase());
    return found ? String(found.value || '') : '';
  }

  function parseRange(value) {
    const match = String(value || '').match(/bytes=(\d+)-(\d*)/i);
    if (!match) return null;
    return {
      start: Number(match[1]),
      end: match[2] ? Number(match[2]) : null,
    };
  }

  function classifyResource(resource) {
    const url = resource.url || '';
    const extension = getExtension(url);
    const contentType = String(resource.contentType || headerValue(resource.responseHeaders, 'content-type')).toLowerCase();
    const range = resource.range || headerValue(resource.requestHeaders, 'range');

    if (extension === 'm3u8' || extension === 'm3u' || contentType.includes('mpegurl')) return 'hls';
    if (extension === 'mpd' || contentType.includes('dash+xml')) return 'dash';
    if (range && ['mp4', 'webm', 'm4a', 'mp3'].includes(extension)) return 'range';
    if (['ts', 'm2ts', 'm4s', 'cmfv', 'cmfa', 'fmp4', 'aac', 'm4a'].includes(extension)) return 'segment';
    if (contentType.startsWith('video/') || contentType.startsWith('audio/')) return 'media';
    if (extension && MEDIA_EXTENSIONS.has(extension)) return 'media';
    return 'other';
  }

  function resourceKey(resource) {
    const range = resource.range || headerValue(resource.requestHeaders, 'range') || '';
    return `${resource.url || ''}|${range}`;
  }

  function dedupeResources(resources) {
    const map = new Map();
    for (const resource of resources || []) {
      if (!resource || !resource.url) continue;
      const key = resourceKey(resource);
      const previous = map.get(key);
      if (!previous || Number(resource.timeStamp || 0) < Number(previous.timeStamp || 0)) {
        map.set(key, { ...resource, kind: resource.kind || classifyResource(resource) });
      } else {
        Object.assign(previous, {
          requestHeaders: previous.requestHeaders?.length ? previous.requestHeaders : resource.requestHeaders,
          responseHeaders: previous.responseHeaders?.length ? previous.responseHeaders : resource.responseHeaders,
          contentType: previous.contentType || resource.contentType,
          contentLength: previous.contentLength || resource.contentLength,
          statusCode: previous.statusCode || resource.statusCode,
        });
        const strongerKind = resource.kind && resource.kind !== 'other' ? resource.kind : classifyResource(previous);
        if (strongerKind !== 'other') previous.kind = strongerKind;
      }
    }
    return [...map.values()];
  }

  function sortCaptured(resources) {
    return dedupeResources(resources).sort((a, b) => {
      const bucketA = Number.isFinite(a.bucket) ? a.bucket : Number.MAX_SAFE_INTEGER;
      const bucketB = Number.isFinite(b.bucket) ? b.bucket : Number.MAX_SAFE_INTEGER;
      if (bucketA !== bucketB) return bucketA - bucketB;
      const rangeA = parseRange(a.range || headerValue(a.requestHeaders, 'range'));
      const rangeB = parseRange(b.range || headerValue(b.requestHeaders, 'range'));
      if (rangeA && rangeB && a.url === b.url && rangeA.start !== rangeB.start) return rangeA.start - rangeB.start;
      return Number(a.timeStamp || 0) - Number(b.timeStamp || 0);
    });
  }

  function parseAttributeList(value) {
    const result = {};
    const regex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
    let match;
    while ((match = regex.exec(value || ''))) {
      let parsed = match[2].trim();
      if (parsed.startsWith('"') && parsed.endsWith('"')) parsed = parsed.slice(1, -1);
      result[match[1].toUpperCase()] = parsed;
    }
    return result;
  }

  function parseByteRange(value, previousEnd) {
    const match = String(value || '').trim().match(/^(\d+)(?:@(\d+))?$/);
    if (!match) return null;
    const length = Number(match[1]);
    const start = match[2] ? Number(match[2]) : Number(previousEnd || 0);
    return { start, end: start + length - 1, length };
  }

  function parseIv(value, sequence) {
    if (value) {
      const clean = value.replace(/^0x/i, '').padStart(32, '0').slice(-32);
      if (/^[0-9a-f]{32}$/i.test(clean)) {
        return Uint8Array.from(clean.match(/../g).map((pair) => parseInt(pair, 16)));
      }
    }
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(12, sequence >>> 0);
    return iv;
  }

  function parseHls(text, baseUrl) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim());
    if (!lines.some((line) => line === '#EXTM3U')) throw new Error('Это не HLS playlist');

    const variants = [];
    const media = [];
    const segments = [];
    let pendingVariant = null;
    let pendingDuration = null;
    let pendingByteRange = null;
    let previousByteEnd = 0;
    let mediaSequence = 0;
    let sequence = 0;
    let currentKey = null;
    let currentMap = null;
    let endList = false;

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        pendingVariant = parseAttributeList(line.slice(line.indexOf(':') + 1));
        continue;
      }
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
        if (attrs.URI) attrs.url = new URL(attrs.URI, baseUrl).href;
        media.push(attrs);
        continue;
      }
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = Number(line.split(':')[1]) || 0;
        sequence = mediaSequence;
        continue;
      }
      if (line.startsWith('#EXTINF:')) {
        pendingDuration = Number(line.slice(line.indexOf(':') + 1).split(',')[0]) || 0;
        continue;
      }
      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingByteRange = parseByteRange(line.slice(line.indexOf(':') + 1), previousByteEnd);
        if (pendingByteRange) previousByteEnd = pendingByteRange.end + 1;
        continue;
      }
      if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
        currentKey = attrs.METHOD === 'NONE' ? null : {
          method: attrs.METHOD,
          url: attrs.URI ? new URL(attrs.URI, baseUrl).href : '',
          ivText: attrs.IV || '',
        };
        continue;
      }
      if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
        currentMap = {
          url: new URL(attrs.URI, baseUrl).href,
          range: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null,
        };
        continue;
      }
      if (line === '#EXT-X-ENDLIST') {
        endList = true;
        continue;
      }
      if (line.startsWith('#')) continue;

      const url = new URL(line, baseUrl).href;
      if (pendingVariant) {
        variants.push({ ...pendingVariant, url });
        pendingVariant = null;
        continue;
      }

      const key = currentKey ? {
        ...currentKey,
        iv: Array.from(parseIv(currentKey.ivText, sequence)),
      } : null;
      segments.push({
        index: segments.length,
        sequence,
        url,
        duration: pendingDuration || 0,
        range: pendingByteRange,
        key,
        map: currentMap,
      });
      sequence += 1;
      pendingDuration = null;
      pendingByteRange = null;
    }

    return {
      isMaster: variants.length > 0,
      variants,
      media,
      segments,
      mediaSequence,
      endList,
      hasMap: Boolean(segments.some((segment) => segment.map)),
    };
  }

  function chooseHlsVariant(master) {
    const variants = [...(master.variants || [])];
    if (!variants.length) return null;
    variants.sort((a, b) => Number(b.BANDWIDTH || b['AVERAGE-BANDWIDTH'] || 0) - Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0));
    return variants.find((variant) => !variant.AUDIO) || variants[0];
  }

  function chooseAudioRendition(master, variant) {
    if (!variant?.AUDIO) return null;
    const candidates = (master.media || []).filter((item) => item.TYPE === 'AUDIO' && item['GROUP-ID'] === variant.AUDIO && item.url);
    return candidates.find((item) => item.DEFAULT === 'YES') || candidates.find((item) => item.AUTOSELECT === 'YES') || candidates[0] || null;
  }

  function commonPathPrefix(urls) {
    if (!urls.length) return '';
    const paths = urls.map((value) => {
      try { return new URL(value).pathname.split('/'); } catch (_) { return []; }
    });
    const result = [];
    const min = Math.min(...paths.map((parts) => parts.length));
    for (let index = 0; index < min; index += 1) {
      const value = paths[0][index];
      if (paths.every((parts) => parts[index] === value)) result.push(value);
      else break;
    }
    return result.join('/');
  }

  function groupRawResources(resources) {
    const sorted = sortCaptured(resources).filter((resource) => ['segment', 'range', 'media'].includes(resource.kind || classifyResource(resource)));
    const groups = new Map();
    for (const resource of sorted) {
      const range = resource.range || headerValue(resource.requestHeaders, 'range');
      let key;
      if (range) key = `range:${resource.url}`;
      else {
        let parsed;
        try { parsed = new URL(resource.url); } catch (_) { continue; }
        const directory = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1);
        key = `path:${parsed.origin}${directory}|${getExtension(resource.url)}`;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(resource);
    }
    return [...groups.entries()]
      .map(([key, items]) => ({ key, items, prefix: commonPathPrefix(items.map((item) => item.url)) }))
      .sort((a, b) => b.items.length - a.items.length);
  }

  function makeSeekPositions(start, end, step) {
    const from = Math.max(0, Number(start) || 0);
    const to = Math.max(from, Number(end) || 0);
    const size = Math.max(1, Number(step) || 8);
    const positions = [];
    for (let current = from; current < to; current += size) positions.push(Math.min(current, to));
    if (!positions.length || positions[positions.length - 1] < to - 0.25) positions.push(Math.max(from, to - 0.25));
    return positions;
  }

  return {
    MEDIA_EXTENSIONS,
    clamp,
    sanitizeFileName,
    getExtension,
    headerValue,
    parseRange,
    classifyResource,
    resourceKey,
    dedupeResources,
    sortCaptured,
    parseAttributeList,
    parseByteRange,
    parseIv,
    parseHls,
    chooseHlsVariant,
    chooseAudioRendition,
    groupRawResources,
    makeSeekPositions,
  };
});
