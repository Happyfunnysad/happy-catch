'use strict';

importScripts('core.js');

const Core = globalThis.SeekFragmentCore;
const sessions = new Map();
const requests = new Map();
const MAX_CAPTURED_REQUESTS = 20_000;

function now() {
  return Date.now();
}

function normalizeHeaders(headers) {
  return (headers || []).map((item) => ({ name: item.name || '', value: item.value || '' }));
}

function headerValue(headers, name) {
  return Core.headerValue(headers, name);
}

function looksUseful(record) {
  const kind = Core.classifyResource(record);
  if (kind !== 'other') return true;
  const type = String(record.contentType || '').toLowerCase();
  const size = Number(record.contentLength || 0);
  if (type.includes('octet-stream') && size >= 16 * 1024) return true;
  if (record.synthetic && Number(record.transferSize || record.encodedBodySize || 0) >= 8 * 1024) return true;
  if (record.webRequestType === 'media') return true;
  return false;
}

function sessionSnapshot(session) {
  if (!session) return null;
  return {
    id: session.id,
    tabId: session.tabId,
    status: session.status,
    currentPosition: session.currentPosition,
    currentBucket: session.currentBucket,
    requestCount: session.resources.size,
    usefulCount: [...session.resources.values()].filter(looksUseful).length,
    lastRequestAt: session.lastRequestAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt || null,
    progress: session.progress || 0,
    error: session.error || '',
    title: session.title,
  };
}

async function probeTab(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  const media = [];
  for (const frame of frames) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'PROBE_MEDIA' }, { frameId: frame.frameId });
      for (const item of response?.media || []) {
        media.push({ ...item, frameId: frame.frameId, key: `${frame.frameId}:${item.index}` });
      }
    } catch (_) {}
  }
  media.sort((a, b) => {
    const area = (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
    if (area) return area;
    return Number(b.duration || 0) - Number(a.duration || 0);
  });
  return media;
}

function createSession(tab, media, settings) {
  const id = crypto.randomUUID();
  const session = {
    id,
    tabId: tab.id,
    frameId: media.frameId,
    mediaIndex: media.index,
    title: Core.sanitizeFileName(tab.title || 'video'),
    pageUrl: tab.url,
    status: 'starting',
    startedAt: now(),
    currentPosition: 0,
    currentBucket: -1,
    lastRequestAt: 0,
    progress: 0,
    resources: new Map(),
    requestIds: new Set(),
    settings,
    media,
    observedUrls: new Set(),
  };
  sessions.set(tab.id, session);
  return session;
}

function recordObservedUrl(session, entry) {
  if (!entry?.url || session.resources.size >= MAX_CAPTURED_REQUESTS) return;
  const key = `${entry.url}|`;
  if (session.resources.has(key)) return;
  const record = {
    url: entry.url,
    timeStamp: entry.startTime ? session.startedAt + entry.startTime : now(),
    bucket: Number.isFinite(entry.bucket) ? entry.bucket : session.currentBucket,
    position: Number.isFinite(entry.position) ? entry.position : session.currentPosition,
    webRequestType: 'performance',
    initiator: session.pageUrl,
    synthetic: true,
    transferSize: Number(entry.transferSize || 0),
    encodedBodySize: Number(entry.encodedBodySize || 0),
    initiatorType: entry.initiatorType || '',
  };
  record.kind = Core.classifyResource(record);
  session.resources.set(key, record);
  session.observedUrls.add(entry.url);
}

function getSessionForRequest(details) {
  const session = sessions.get(details.tabId);
  if (!session || !['starting', 'sweeping'].includes(session.status)) return null;
  return session;
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  const session = getSessionForRequest(details);
  if (!session) return;
  if (!['media', 'xmlhttprequest', 'other'].includes(details.type)) return;
  if (session.requestIds.size >= MAX_CAPTURED_REQUESTS) return;

  const record = {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    timeStamp: details.timeStamp || now(),
    bucket: session.currentBucket,
    position: session.currentPosition,
    webRequestType: details.type,
    initiator: details.initiator || session.pageUrl,
    requestHeaders: [],
    responseHeaders: [],
  };
  requests.set(details.requestId, record);
  session.requestIds.add(details.requestId);
  session.lastRequestAt = now();
}, { urls: ['<all_urls>'] });

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  const session = getSessionForRequest(details);
  const record = requests.get(details.requestId);
  if (!session || !record) return;
  record.requestHeaders = normalizeHeaders(details.requestHeaders);
  record.range = headerValue(record.requestHeaders, 'range');
  session.lastRequestAt = now();
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const session = getSessionForRequest(details);
  const record = requests.get(details.requestId);
  if (!session || !record) return;
  record.responseHeaders = normalizeHeaders(details.responseHeaders);
  record.contentType = headerValue(record.responseHeaders, 'content-type').split(';')[0].trim();
  record.contentLength = Number(headerValue(record.responseHeaders, 'content-length')) || 0;
  record.statusCode = details.statusCode;
  record.kind = Core.classifyResource(record);
  if (record.kind === 'other' && String(record.contentType).toLowerCase().includes('octet-stream') && record.contentLength >= 16 * 1024) {
    record.kind = 'segment';
  }
  session.lastRequestAt = now();
}, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders']);

function finalizeRequest(details, failed) {
  const record = requests.get(details.requestId);
  if (!record) return;
  requests.delete(details.requestId);
  const session = sessions.get(details.tabId);
  if (!session) return;
  session.requestIds.delete(details.requestId);
  record.completedAt = details.timeStamp || now();
  record.failed = Boolean(failed);
  if (failed) record.error = details.error || 'request failed';
  if (!failed && looksUseful(record)) {
    session.resources.set(Core.resourceKey(record), record);
  }
  session.lastRequestAt = now();
}

chrome.webRequest.onCompleted.addListener((details) => finalizeRequest(details, false), { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener((details) => finalizeRequest(details, true), { urls: ['<all_urls>'] });

async function startCapture(message) {
  const tab = await chrome.tabs.get(message.tabId);
  const mediaList = await probeTab(tab.id);
  const selected = mediaList.find((item) => item.key === message.mediaKey) || mediaList[0];
  if (!selected) throw new Error('На странице не найден HTML5-плеер');

  const duration = Number(selected.duration);
  const start = Core.clamp(message.settings?.start, 0, duration, 0);
  const end = Core.clamp(message.settings?.end, start + 0.1, duration, duration);
  const settings = {
    start,
    end,
    step: Core.clamp(message.settings?.step, 1, 120, 8),
    minDwellMs: Math.round(Core.clamp(message.settings?.minDwellMs, 250, 10_000, 700)),
    quietMs: Math.round(Core.clamp(message.settings?.quietMs, 250, 10_000, 700)),
    maxDwellMs: Math.round(Core.clamp(message.settings?.maxDwellMs, 1_000, 30_000, 4_000)),
  };

  const old = sessions.get(tab.id);
  if (old && ['starting', 'sweeping'].includes(old.status)) {
    throw new Error('Захват в этой вкладке уже запущен');
  }

  const session = createSession(tab, selected, settings);
  session.status = 'sweeping';
  await chrome.tabs.sendMessage(tab.id, {
    type: 'START_SEEK_SWEEP',
    sessionId: session.id,
    mediaIndex: selected.index,
    settings,
  }, { frameId: selected.frameId });
  return sessionSnapshot(session);
}

async function buildJob(session) {
  const resources = Core.sortCaptured([...session.resources.values()]);
  const useful = resources.filter(looksUseful);
  const jobId = session.id;
  const job = {
    id: jobId,
    title: session.title,
    pageUrl: session.pageUrl,
    tabId: session.tabId,
    createdAt: now(),
    resources: useful,
    settings: session.settings,
    media: session.media,
  };
  await chrome.storage.local.set({ [`captureJob:${jobId}`]: job });
  return job;
}

async function finishCapture(session, error) {
  session.completedAt = now();
  if (error) {
    session.status = 'error';
    session.error = String(error.message || error);
    return;
  }
  session.status = 'captured';
  session.progress = 1;
  const job = await buildJob(session);
  session.status = 'assembling';
  await chrome.tabs.create({ url: chrome.runtime.getURL(`assembler.html?job=${encodeURIComponent(job.id)}`) });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'PROBE_TAB': {
        const media = await probeTab(message.tabId);
        sendResponse({ ok: true, media });
        break;
      }
      case 'START_CAPTURE': {
        const snapshot = await startCapture(message);
        sendResponse({ ok: true, session: snapshot });
        break;
      }
      case 'GET_CAPTURE_STATUS': {
        sendResponse({ ok: true, session: sessionSnapshot(sessions.get(message.tabId)) });
        break;
      }
      case 'STOP_CAPTURE': {
        const session = sessions.get(message.tabId);
        if (session) {
          session.status = 'cancelled';
          session.error = 'Остановлено пользователем';
          await chrome.tabs.sendMessage(session.tabId, { type: 'STOP_SEEK_SWEEP', sessionId: session.id }, { frameId: session.frameId }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case 'SWEEP_POSITION': {
        const session = sessions.get(sender.tab?.id);
        if (session && session.id === message.sessionId) {
          session.currentBucket = message.bucket;
          session.currentPosition = message.position;
          session.progress = message.progress || 0;
          session.status = 'sweeping';
        }
        sendResponse({ ok: true });
        break;
      }
      case 'OBSERVED_RESOURCES': {
        const session = sessions.get(sender.tab?.id);
        if (session && session.id === message.sessionId) {
          for (const entry of message.entries || []) recordObservedUrl(session, entry);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'GET_NETWORK_ACTIVITY': {
        const session = sessions.get(sender.tab?.id);
        sendResponse({
          ok: true,
          count: session?.resources.size || 0,
          activeRequests: session?.requestIds.size || 0,
          lastRequestAt: session?.lastRequestAt || 0,
          status: session?.status || 'missing',
        });
        break;
      }
      case 'SWEEP_COMPLETE': {
        const session = sessions.get(sender.tab?.id);
        if (session && session.id === message.sessionId) {
          for (const entry of message.entries || []) recordObservedUrl(session, entry);
          await finishCapture(session, null);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'SWEEP_FAILED': {
        const session = sessions.get(sender.tab?.id);
        if (session && session.id === message.sessionId) await finishCapture(session, new Error(message.error || 'Ошибка перемотки'));
        sendResponse({ ok: true });
        break;
      }
      case 'ASSEMBLY_DONE': {
        const session = [...sessions.values()].find((item) => item.id === message.jobId);
        if (session) session.status = message.ok ? 'done' : 'error';
        if (session && !message.ok) session.error = message.error || 'Ошибка сборки';
        await chrome.storage.local.remove(`captureJob:${message.jobId}`);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })().catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('seek-capture:')) return;
  port.onMessage.addListener(() => {});
});
