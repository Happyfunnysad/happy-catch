'use strict';

// Keep capture/session orchestration in the existing worker, but own the final
// browser download here. This mirrors Triangle Downloader: DOM/OPFS work stays in
// an extension page, while chrome.downloads is called by the service worker.
importScripts('service-worker.js');

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'output-download') return;

  port.onMessage.addListener(async (message) => {
    if (message?.type !== 'DOWNLOAD_OUTPUT') return;
    try {
      const url = String(message.url || '');
      const filename = String(message.filename || 'video.bin');
      if (!url.startsWith('blob:') && !url.startsWith('data:')) {
        throw new Error('Недопустимый URL готового файла');
      }
      const id = await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      port.postMessage({ type: 'DOWNLOAD_ACCEPTED', ok: true, id });
    } catch (error) {
      port.postMessage({
        type: 'DOWNLOAD_ACCEPTED',
        ok: false,
        error: String(error?.message || error),
      });
    }
  });
});