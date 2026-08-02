(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SeekSweepStrategy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeRanges(ranges) {
    return (ranges || [])
      .map((range) => ({ start: Number(range.start), end: Number(range.end) }))
      .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end >= range.start)
      .sort((a, b) => a.start - b.start);
  }

  function bufferedEnd(ranges, position, tolerance = 0.75) {
    const cursor = Number(position) || 0;
    let end = cursor;
    for (const range of normalizeRanges(ranges)) {
      if (range.start <= cursor + tolerance && range.end >= cursor - tolerance) {
        end = Math.max(end, range.end);
      }
    }
    return end;
  }

  function nextPosition({ cursor, edge, end, fallbackStep = 8, stalls = 0 }) {
    const current = Math.max(0, Number(cursor) || 0);
    const limit = Math.max(current, Number(end) || current);
    const buffered = Math.max(current, Number(edge) || current);
    if (buffered >= limit - 0.4 || current >= limit - 0.4) {
      return { done: true, position: limit, usedBuffer: buffered > current + 0.5 };
    }

    if (buffered > current + 0.75) {
      const position = Math.min(limit - 0.05, Math.max(current + 0.25, buffered - 0.08));
      return { done: false, position, usedBuffer: true };
    }

    const base = Math.max(1, Number(fallbackStep) || 8);
    const multiplier = Math.min(2.5, 1 + Math.max(0, Number(stalls) || 0) * 0.25);
    const position = Math.min(limit - 0.05, current + base * multiplier);
    return { done: position <= current + 0.01, position, usedBuffer: false };
  }

  function progress(start, end, position) {
    const from = Number(start) || 0;
    const to = Math.max(from + 0.001, Number(end) || from + 0.001);
    return Math.max(0, Math.min(1, ((Number(position) || from) - from) / (to - from)));
  }

  return { normalizeRanges, bufferedEnd, nextPosition, progress };
});