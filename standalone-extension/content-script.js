(() => {
  'use strict';

  const Core = globalThis.SeekFragmentCore;
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  async function seek(media, position) {
    const duration = Number.isFinite(media.duration) ? media.duration : position;
    const target = Math.max(0, Math.min(duration, position));
    if (Math.abs(media.currentTime - target) < 0.15) return;
    const wait = once(media, 'seeked', 20_000).catch(() => null);
    media.currentTime = target;
    await wait;
  }

  function performanceEntries(bucket, position) {
    return performance.getEntriesByType('resource').map((entry) => ({
      url: entry.name,
      initiatorType: entry.initiatorType,
      startTime: entry.startTime,
      duration: entry.duration,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      bucket,
      position,
    }));
  }

  async function sendObserved(sessionId, bucket, position) {
    const entries = performanceEntries(bucket, position);
    if (entries.length) {
      await chrome.runtime.sendMessage({ type: 'OBSERVED_RESOURCES', sessionId, entries }).catch(() => {});
    }
  }

  async function waitForNetworkQuiet(sessionId, settings, startedAt) {
    let lastCount = -1;
    let stableSince = Date.now();
    const deadline = startedAt + settings.maxDwellMs;
    while (Date.now() < deadline) {
      if (!activeSweep || activeSweep.cancelled) throw new Error('Перемотка остановлена');
      const status = await chrome.runtime.sendMessage({ type: 'GET_NETWORK_ACTIVITY', sessionId }).catch(() => null);
      const count = Number(status?.count || 0);
      const active = Number(status?.activeRequests || 0);
      if (count !== lastCount) {
        lastCount = count;
        stableSince = Date.now();
      }
      const elapsed = Date.now() - startedAt;
      const quietFor = Date.now() - Math.max(stableSince, Number(status?.lastRequestAt || 0));
      if (elapsed >= settings.minDwellMs && active === 0 && quietFor >= settings.quietMs) return;
      await sleep(150);
    }
  }

  async function runSweep(message) {
    if (activeSweep) throw new Error('Перемотка уже запущена');
    const media = collectMedia()[message.mediaIndex];
    if (!media) throw new Error('Плеер исчез со страницы');
    if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error('Не удалось определить длительность');

    const settings = message.settings;
    const positions = Core.makeSeekPositions(settings.start, settings.end, settings.step);
    const previous = {
      currentTime: media.currentTime,
      paused: media.paused,
      muted: media.muted,
      volume: media.volume,
      playbackRate: media.playbackRate,
      preload: media.preload,
    };
    const port = chrome.runtime.connect({ name: `seek-capture:${message.sessionId}` });
    activeSweep = { sessionId: message.sessionId, cancelled: false, port };
    const heartbeat = setInterval(() => {
      try { port.postMessage({ at: Date.now() }); } catch (_) {}
    }, 20_000);

    try {
      media.preload = 'auto';
      media.muted = true;
      media.volume = 0;
      media.playbackRate = 1;
      media.pause();
      await sendObserved(message.sessionId, -1, media.currentTime);

      for (let bucket = 0; bucket < positions.length; bucket += 1) {
        if (activeSweep.cancelled) throw new Error('Перемотка остановлена');
        const position = positions[bucket];
        await chrome.runtime.sendMessage({
          type: 'SWEEP_POSITION',
          sessionId: message.sessionId,
          bucket,
          position,
          progress: bucket / positions.length,
        });

        media.pause();
        await seek(media, position);
        const startedAt = Date.now();
        await media.play().catch(() => {});
        await waitForNetworkQuiet(message.sessionId, settings, startedAt);
        media.pause();
        await sendObserved(message.sessionId, bucket, position);
      }

      await chrome.runtime.sendMessage({
        type: 'SWEEP_COMPLETE',
        sessionId: message.sessionId,
        entries: performanceEntries(positions.length, settings.end),
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
