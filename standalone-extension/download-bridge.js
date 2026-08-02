'use strict';

(() => {
  const nativeDownload = chrome.downloads.download.bind(chrome.downloads);

  function backgroundDownload(options) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'output-download' });
      let settled = false;
      const timer = setTimeout(() => finish(new Error('Service worker не подтвердил загрузку')), 30_000);

      const finish = (error, id) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { port.disconnect(); } catch (_) {}
        error ? reject(error) : resolve(id);
      };

      port.onMessage.addListener((message) => {
        if (message?.type !== 'DOWNLOAD_ACCEPTED') return;
        if (!message.ok) finish(new Error(message.error || 'Не удалось запустить скачивание'));
        else finish(null, message.id);
      });
      port.onDisconnect.addListener(() => {
        if (!settled) finish(new Error(chrome.runtime.lastError?.message || 'Service worker отключился'));
      });
      port.postMessage({
        type: 'DOWNLOAD_OUTPUT',
        jobId: new URL(location.href).searchParams.get('job') || '',
        url: options.url,
        filename: options.filename,
      });
    });
  }

  const routedDownload = (options) => {
    const url = String(options?.url || '');
    if (url.startsWith('blob:') || url.startsWith('data:')) return backgroundDownload(options || {});
    return nativeDownload(options);
  };

  try {
    chrome.downloads.download = routedDownload;
  } catch (_) {
    Object.defineProperty(chrome.downloads, 'download', {
      configurable: true,
      value: routedDownload,
    });
  }
})();