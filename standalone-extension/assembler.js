(() => {
  'use strict';

  const Core = globalThis.SeekFragmentCore;
  const summary = document.querySelector('#summary');
  const progress = document.querySelector('#progress');
  const logBox = document.querySelector('#log');
  const retryButton = document.querySelector('#retry');
  const closeButton = document.querySelector('#close');
  const jobId = new URL(location.href).searchParams.get('job');
  let currentJob = null;
  let headerRuleIds = [];

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    logBox.textContent += `${line}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  }

  function setProgress(done, total) {
    progress.value = total ? done / total : 0;
  }

  function safeRequestHeaders(resource, extra = {}) {
    const forbidden = new Set([
      'accept-encoding', 'connection', 'content-length', 'cookie', 'host', 'origin', 'referer',
      'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'user-agent',
    ]);
    const headers = {};
    for (const item of resource?.requestHeaders || []) {
      const name = String(item.name || '').toLowerCase();
      if (!name || forbidden.has(name) || name.startsWith('sec-ch-')) continue;
      headers[item.name] = item.value || '';
    }
    return { ...headers, ...extra };
  }

  async function installHeaderRules(job) {
    const referer = job.pageUrl;
    if (!referer || !chrome.declarativeNetRequest?.updateSessionRules) return;
    const origin = new URL(referer).origin;
    const hosts = [...new Set(job.resources.map((resource) => {
      try { return new URL(resource.url).hostname; } catch (_) { return ''; }
    }).filter(Boolean))].slice(0, 100);
    const base = 400_000 + Math.floor(Math.random() * 100_000);
    const rules = hosts.map((host, index) => ({
      id: base + index,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: referer },
          { header: 'Origin', operation: 'set', value: origin },
        ],
      },
      condition: {
        requestDomains: [host],
        resourceTypes: ['xmlhttprequest'],
      },
    }));
    headerRuleIds = rules.map((rule) => rule.id);
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules, removeRuleIds: headerRuleIds });
  }

  async function removeHeaderRules() {
    if (!headerRuleIds.length) return;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: headerRuleIds }).catch(() => {});
    headerRuleIds = [];
  }

  async function fetchResponse(url, resource, options = {}) {
    const headers = safeRequestHeaders(resource, options.headers || {});
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      headers,
    });
    if (!response.ok && response.status !== 206) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    return response;
  }

  async function fetchBytes(url, resource, range) {
    const headers = {};
    if (range) headers.Range = `bytes=${range.start}-${range.end ?? ''}`;
    const response = await fetchResponse(url, resource, { headers });
    return new Uint8Array(await response.arrayBuffer());
  }

  async function fetchText(url, resource) {
    const response = await fetchResponse(url, resource);
    return response.text();
  }

  function resourceForUrl(job, url) {
    let target;
    try { target = new URL(url); } catch (_) { return job.resources[0]; }
    return job.resources.find((resource) => {
      try {
        const current = new URL(resource.url);
        return current.origin === target.origin && current.pathname === target.pathname;
      } catch (_) { return false; }
    }) || job.resources.find((resource) => {
      try { return new URL(resource.url).origin === target.origin; } catch (_) { return false; }
    }) || job.resources[0];
  }

  async function openOutput(name) {
    if (!navigator.storage?.getDirectory) throw new Error('OPFS недоступен в этом браузере');
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return { root, handle, writable, name };
  }

  async function finishOutput(output) {
    await output.writable.close();
    const file = await output.handle.getFile();
    const url = URL.createObjectURL(file);
    await chrome.downloads.download({ url, filename: output.name, saveAs: true });
    setTimeout(async () => {
      URL.revokeObjectURL(url);
      await output.root.removeEntry(output.name).catch(() => {});
    }, 10 * 60 * 1000);
    return file.size;
  }

  async function decryptAes128(bytes, keyBytes, ivBytes) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, bytes);
    return new Uint8Array(decrypted);
  }

  function outputExtension(playlist) {
    if (playlist.hasMap) return 'mp4';
    const ext = Core.getExtension(playlist.segments[0]?.url || '');
    if (['ts', 'm2ts'].includes(ext)) return 'ts';
    if (['aac', 'm4a', 'mp3'].includes(ext)) return ext;
    return 'mp4';
  }

  async function resolveHlsPlaylist(job, manifestResource, depth = 0) {
    if (depth > 3) throw new Error('Слишком глубокая HLS master-цепочка');
    const text = manifestResource.body || await fetchText(manifestResource.url, manifestResource);
    const playlist = Core.parseHls(text, manifestResource.url);
    if (!playlist.isMaster) return { playlist, resource: manifestResource, master: null, variant: null, audio: null };
    const variant = Core.chooseHlsVariant(playlist);
    if (!variant) throw new Error('В master playlist нет вариантов');
    log(`HLS master: выбран поток ${variant.RESOLUTION || ''} ${variant.BANDWIDTH || ''}`.trim());
    const childResource = resourceForUrl(job, variant.url);
    const child = await resolveHlsPlaylist(job, { ...childResource, url: variant.url }, depth + 1);
    child.master = playlist;
    child.variant = variant;
    child.audio = Core.chooseAudioRendition(playlist, variant);
    return child;
  }

  async function writeHlsTrack(job, resolved, suffix = '') {
    const { playlist, resource } = resolved;
    if (!playlist.segments.length) throw new Error('HLS playlist не содержит сегментов');
    const extension = outputExtension(playlist);
    const fileName = `${job.title}${suffix}.${extension}`;
    const output = await openOutput(fileName);
    const keyCache = new Map();
    let currentMapKey = '';
    let completed = 0;

    try {
      for (const segment of playlist.segments) {
        if (segment.map) {
          const mapKey = `${segment.map.url}|${JSON.stringify(segment.map.range || null)}`;
          if (mapKey !== currentMapKey) {
            const mapResource = resourceForUrl(job, segment.map.url) || resource;
            const mapBytes = await fetchBytes(segment.map.url, mapResource, segment.map.range);
            await output.writable.write(mapBytes);
            currentMapKey = mapKey;
          }
        }

        const segmentResource = resourceForUrl(job, segment.url) || resource;
        let bytes = await fetchBytes(segment.url, segmentResource, segment.range);
        if (segment.key) {
          if (segment.key.method !== 'AES-128') throw new Error(`HLS шифрование ${segment.key.method} не поддерживается`);
          if (!keyCache.has(segment.key.url)) {
            keyCache.set(segment.key.url, await fetchBytes(segment.key.url, resourceForUrl(job, segment.key.url) || resource));
          }
          bytes = await decryptAes128(bytes, keyCache.get(segment.key.url), new Uint8Array(segment.key.iv));
        }
        await output.writable.write(bytes);
        completed += 1;
        setProgress(completed, playlist.segments.length);
        summary.textContent = `HLS: ${completed}/${playlist.segments.length}`;
      }
      const size = await finishOutput(output);
      log(`Сохранён ${fileName}: ${(size / 1024 / 1024).toFixed(1)} МБ`);
      return fileName;
    } catch (error) {
      await output.writable.abort().catch(() => {});
      await output.root.removeEntry(output.name).catch(() => {});
      throw error;
    }
  }

  async function assembleHls(job) {
    const manifests = job.resources.filter((resource) => (resource.kind || Core.classifyResource(resource)) === 'hls');
    if (!manifests.length) return false;
    let lastError;
    for (const manifest of manifests) {
      try {
        log(`Пробую HLS manifest: ${manifest.url}`);
        const resolved = await resolveHlsPlaylist(job, manifest);
        await writeHlsTrack(job, resolved, resolved.audio ? '.video' : '');
        if (resolved.audio?.url) {
          log('В HLS используется отдельная аудиодорожка — сохраняю вторым файлом.');
          const audioResource = resourceForUrl(job, resolved.audio.url);
          const audioResolved = await resolveHlsPlaylist(job, { ...audioResource, url: resolved.audio.url });
          await writeHlsTrack(job, audioResolved, '.audio');
        }
        return true;
      } catch (error) {
        lastError = error;
        log(`Manifest не подошёл: ${error.message}`);
      }
    }
    if (lastError) throw lastError;
    return false;
  }

  function inferExtension(resource, bytes) {
    const type = String(resource?.contentType || '').toLowerCase();
    if (type.includes('mp2t')) return 'ts';
    if (type.includes('webm')) return 'webm';
    if (type.includes('mp4')) return 'mp4';
    if (bytes?.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') return 'mp4';
    if (bytes?.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
    if (bytes?.length >= 376 && bytes[0] === 0x47 && bytes[188] === 0x47) return 'ts';
    return Core.getExtension(resource?.url || '') || 'bin';
  }

  async function assembleProgressive(job) {
    const rangeGroups = Core.groupRawResources(job.resources).filter((group) => group.key.startsWith('range:'));
    for (const group of rangeGroups) {
      const resource = group.items[0];
      try {
        log(`Пробую скачать исходный range-файл целиком: ${resource.url}`);
        const response = await fetchResponse(resource.url, resource);
        const extension = Core.getExtension(resource.url) || (String(resource.contentType).includes('webm') ? 'webm' : 'mp4');
        const output = await openOutput(`${job.title}.${extension}`);
        let received = 0;
        const total = Number(response.headers.get('content-length')) || 0;
        const reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await output.writable.write(value);
          received += value.length;
          if (total) setProgress(received, total);
          summary.textContent = `Исходный файл: ${(received / 1024 / 1024).toFixed(1)} МБ`;
        }
        const size = await finishOutput(output);
        log(`Сохранён исходный файл: ${(size / 1024 / 1024).toFixed(1)} МБ`);
        return true;
      } catch (error) {
        log(`Полная загрузка range-файла не удалась: ${error.message}`);
      }
    }
    return false;
  }

  async function assembleRawSegments(job) {
    const groups = Core.groupRawResources(job.resources).filter((group) => !group.key.startsWith('range:'));
    if (!groups.length) return false;
    const selected = groups[0];
    log(`Fallback: собираю ${selected.items.length} перехваченных фрагментов из одной группы.`);
    const firstBytes = await fetchBytes(selected.items[0].url, selected.items[0], Core.parseRange(selected.items[0].range || Core.headerValue(selected.items[0].requestHeaders, 'range')));
    const extension = inferExtension(selected.items[0], firstBytes);
    const output = await openOutput(`${job.title}.${extension}`);
    try {
      await output.writable.write(firstBytes);
      for (let index = 1; index < selected.items.length; index += 1) {
        const resource = selected.items[index];
        const range = Core.parseRange(resource.range || Core.headerValue(resource.requestHeaders, 'range'));
        const bytes = await fetchBytes(resource.url, resource, range);
        await output.writable.write(bytes);
        setProgress(index + 1, selected.items.length);
        summary.textContent = `Фрагменты: ${index + 1}/${selected.items.length}`;
      }
      const size = await finishOutput(output);
      log(`Сохранён raw-файл: ${(size / 1024 / 1024).toFixed(1)} МБ`);
      if (groups.length > 1 && groups[1].items.length >= selected.items.length * 0.6) {
        log('Обнаружена вторая крупная группа: вероятно, отдельная аудио- или видеодорожка. Она пока не mux-ится автоматически.');
      }
      return true;
    } catch (error) {
      await output.writable.abort().catch(() => {});
      await output.root.removeEntry(output.name).catch(() => {});
      throw error;
    }
  }

  async function run() {
    if (!jobId) throw new Error('Не передан job ID');
    const stored = await chrome.storage.local.get(`captureJob:${jobId}`);
    currentJob = stored[`captureJob:${jobId}`];
    if (!currentJob) throw new Error('Задание не найдено или уже удалено');
    summary.textContent = `${currentJob.title}: ${currentJob.resources.length} медиа-кандидатов`;
    log(`Страница: ${currentJob.pageUrl}`);
    log(`Перехвачено ресурсов: ${currentJob.resources.length}`);
    await installHeaderRules(currentJob).catch((error) => log(`Не удалось выставить Referer/Origin: ${error.message}`));

    let assembled = false;
    try {
      assembled = await assembleHls(currentJob);
    } catch (error) {
      log(`HLS-сборка не удалась: ${error.message}`);
    }
    if (!assembled) assembled = await assembleProgressive(currentJob);
    if (!assembled) assembled = await assembleRawSegments(currentJob);
    if (!assembled) throw new Error('Не найден пригодный manifest, range-файл или последовательность сегментов');

    progress.value = 1;
    summary.textContent = 'Готово. Файл передан в загрузки браузера.';
    await chrome.runtime.sendMessage({ type: 'ASSEMBLY_DONE', jobId, ok: true }).catch(() => {});
  }

  async function fail(error) {
    log(`ОШИБКА: ${error.message || error}`);
    summary.textContent = 'Сборка завершилась ошибкой.';
    retryButton.hidden = false;
    await chrome.runtime.sendMessage({ type: 'ASSEMBLY_DONE', jobId, ok: false, error: String(error.message || error) }).catch(() => {});
  }

  retryButton.addEventListener('click', () => {
    retryButton.hidden = true;
    logBox.textContent = '';
    progress.value = 0;
    run().catch(fail);
  });
  closeButton.addEventListener('click', () => window.close());
  addEventListener('beforeunload', removeHeaderRules);

  run().catch(fail).finally(removeHeaderRules);
})();
