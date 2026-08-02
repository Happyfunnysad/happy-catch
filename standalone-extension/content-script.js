(() => {
  'use strict';

  const Strategy = globalThis.SeekSweepStrategy;
  let activeSweep = null;

  function collectMedia(root = document) {
    const result = [];
    const visit = (node) => {
      if (!node?.querySelectorAll) return;
      result.push(...node.querySelectorAll('video, audio'));
      for (const element of node.querySelectorAll('*')) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(root);
    return [...new Set(result)].filter((media) => {
      const duration = Number(media.duration);
      return Boolean(
        media.currentSrc || media.src || media.readyState >= 1 ||
        (Number.isFinite(duration) && duration > 0) || media.videoWidth || media.videoHeight,
      );
    });
  }

  function describeMedia() {
    return collectMedia().map((media, index) => {
      const rect = media.getBoundingClientRect();
      const source = media.currentSrc || media.src || '';
      return {
        index,
        tag: media.tagName,
        duration: Number.isFinite(media.duration) ? media.duration : 0,
        currentTime: Number(media.currentTime) || 0,
        width: Math.round(rect.width || media.videoWidth || 0),
        height: Math.round(rect.height || media.videoHeight || 0),
        source,
        label: source.split(/[?#]/)[0].split('/').pop() || `${media.tagName.toLowerCase()} ${index + 1}`,
      };
    });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function once(target, event, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (value, error) => {
        clearTimeout(timer);
        target.removeEventListener(event, onEvent);
        error ? reject(error) : resolve(value);
      };
      const onEvent = (eventValue) => finish(eventValue, null);
      target.addEventListener(event, onEvent, { once: true });
      timer = setTimeout(() => finish(null, new Error(`Таймаут ${event}`)), timeout);
    });
  }

  async function seek(media, position, force = false) {
    const duration = Number.isFinite(media.duration) ? media.duration : position;
    const target = Math.max(0, Math.min(duration, position));
    if (!force && Math.abs(media.currentTime - target) < 0.15) return;
    const wait = once(media, 'seeked', 12_000).catch(() => null);
    try {
      if (typeof media.fastSeek === 'function') media.fastSeek(target);
      else media.currentTime = target;
    } catch (_) {
      media.currentTime = target;
    }
    await wait;
  }

  function timeRanges(media) {
    const ranges = [];
    try {
      for (let index = 0; index < media.buffered.length; index += 1) {
        ranges.push({ start: media.buffered.start(index), end: media.buffered.end(index) });
      }
    } catch (_) {}
    return ranges;
  }

  function newPerformanceEntries(bucket, position) {
    const entries = [];
    const seen = activeSweep?.seenPerformance;
    for (const entry of performance.getEntriesByType('resource')) {
      const key = `${entry.name}|${entry.startTime}`;
      if (seen?.has(key)) continue;
      seen?.add(key);
      entries.push({
        url: entry.name,
        initiatorType: entry.initiatorType,
        startTime: entry.startTime,
        duration: entry.duration,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        bucket,
        position,
      });
    }
    return entries;
  }

  async function sendObserved(sessionId, bucket, position) {
    const entries = newPerformanceEntries(bucket, position);
    if (!entries.length) return;
    await chrome.runtime.sendMessage({ type: 'OBSERVED_RESOURCES', sessionId, entries }).catch(() => {});
  }

  async function reportPosition(sessionId, bucket, position, progress) {
    await chrome.runtime.sendMessage({
      type: 'SWEEP_POSITION',
      sessionId,
      bucket,
      position,
      progress,
    }).catch(() => {});
  }

  async function waitForNetworkQuiet(sessionId, settings, startedAt) {
    let lastCount = -1;
    let changedAt = startedAt;
    const deadline = startedAt + settings.maxDwellMs;
    while (Date.now() < deadline) {
      if (!activeSweep || activeSweep.cancelled) throw new Error('Перемотка остановлена');
      const status = await chrome.runtime.sendMessage({ type: 'GET_NETWORK_ACTIVITY', sessionId }).catch(() => null);
      const count = Number(status?.count || 0);
      const active = Number(status?.activeRequests || 0);
      if (count !== lastCount) {
        lastCount = count;
        changedAt = Date.now();
      }
      const elapsed = Date.now() - startedAt;
      const lastActivity = Math.max(changedAt, Number(status?.lastRequestAt || 0));
      const quietFor = Date.now() - lastActivity;
      if (elapsed >= settings.minDwellMs && active === 0 && quietFor >= settings.quietMs) return;
      await sleep(100);
    }
  }

  async function runSweep(message) {
    if (activeSweep) throw new Error('Перемотка уже запущена');
    if (!Strategy) throw new Error('Стратегия перемотки не загружена');
    const media = collectMedia()[message.mediaIndex];
    if (!media) throw new Error('Плеер исчез со страницы');
    if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error('Не удалось определить длительность');

    const settings = message.settings;
    const previous = {
      currentTime: media.currentTime,
      paused: media.paused,
      muted: media.muted,
      volume: media.volume,
      playbackRate: media.playbackRate,
      preload: media.preload,
    };
    const port = chrome.runtime.connect({ name: `seek-capture:${message.sessionId}` });
    activeSweep = {
      sessionId: message.sessionId,
      cancelled: false,
      port,
      seenPerformance: new Set(),
    };
    const heartbeat = setInterval(() => {
      try { port.postMessage({ at: Date.now() }); } catch (_) {}
    }, 20_000);

    let cursor = settings.start;
    let bucket = 0;
    let stalls = 0;
    let loops = 0;

    try {
      media.preload = 'auto';
      media.muted = true;
      media.volume = 0;
      media.playbackRate = 1;
      media.pause();
      await sendObserved(message.sessionId, -1, media.currentTime);

      while (cursor < settings.end - 0.4) {
        if (activeSweep.cancelled) throw new Error('Перемотка остановлена');
        if (loops++ > 2_000) throw new Error('Слишком много итераций перемотки');

        await reportPosition(
          message.sessionId,
          bucket,
          cursor,
          Strategy.progress(settings.start, settings.end, cursor),
        );

        media.pause();
        await seek(media, cursor, bucket === 0);
        const startedAt = Date.now();
        await media.play().catch(() => {});
        await waitForNetworkQuiet(message.sessionId, settings, startedAt);
        media.pause();
        await sendObserved(message.sessionId, bucket, cursor);

        const edge = Strategy.bufferedEnd(timeRanges(media), cursor);
        const reached = Math.max(cursor, edge);
        await reportPosition(
          message.sessionId,
          bucket,
          reached,
          Strategy.progress(settings.start, settings.end, reached),
        );

        const next = Strategy.nextPosition({
          cursor,
          edge,
          end: settings.end,
          fallbackStep: settings.step,
          stalls,
        });
        if (next.done) break;
        stalls = next.usedBuffer ? 0 : stalls + 1;
        if (next.position <= cursor + 0.01) throw new Error('Плеер перестал продвигать буфер');
        cursor = next.position;
        bucket += 1;
      }

      await sendObserved(message.sessionId, bucket + 1, settings.end);
      await chrome.runtime.sendMessage({
        type: 'SWEEP_COMPLETE',
        sessionId: message.sessionId,
        entries: newPerformanceEntries(bucket + 1, settings.end),
      });
    } catch (error) {
      await chrome.runtime.sendMessage({
        type: 'SWEEP_FAILED',
        sessionId: message.sessionId,
        error: String(error.message || error),
      }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      try { port.disconnect(); } catch (_) {}
      media.pause();
      try { media.preload = previous.preload; } catch (_) {}
      try { media.muted = previous.muted; } catch (_) {}
      try { media.volume = previous.volume; } catch (_) {}
      try { media.playbackRate = previous.playbackRate; } catch (_) {}
      try { await seek(media, previous.currentTime); } catch (_) {}
      if (!previous.paused) media.play().catch(() => {});
      activeSweep = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PROBE_MEDIA') {
      sendResponse({ media: describeMedia() });
      return;
    }
    if (message?.type === 'START_SEEK_SWEEP') {
      runSweep(message).catch((error) => {
        chrome.runtime.sendMessage({ type: 'SWEEP_FAILED', sessionId: message.sessionId, error: String(error.message || error) }).catch(() => {});
      });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'STOP_SEEK_SWEEP') {
      if (activeSweep && activeSweep.sessionId === message.sessionId) activeSweep.cancelled = true;
      sendResponse({ ok: true });
    }
  });
})();