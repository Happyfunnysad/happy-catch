(() => {
    'use strict';

    if (globalThis.__happyCatchFragmentPipelineLoaded) return;
    globalThis.__happyCatchFragmentPipelineLoaded = true;

    // PIPELINE_CORE_START
    function clampNumber(value, min, max, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    function buildRanges(start, end, chunkSeconds) {
        const from = Math.max(0, Number(start) || 0);
        const to = Math.max(from, Number(end) || 0);
        const size = Math.max(5, Number(chunkSeconds) || 120);
        const ranges = [];
        let cursor = from;
        let index = 0;
        while (cursor < to - 0.05) {
            const next = Math.min(to, cursor + size);
            ranges.push({ index, start: cursor, end: next });
            cursor = next;
            index++;
        }
        return ranges;
    }

    function distributeRanges(ranges, workers) {
        const count = Math.max(1, Math.floor(Number(workers) || 1));
        const assignments = Array.from({ length: count }, () => []);
        ranges.forEach((range, index) => assignments[index % count].push(range));
        return assignments;
    }

    function sanitizeFileName(value) {
        return String(value || 'video')
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 150) || 'video';
    }

    function chooseMime(media) {
        const audioOnly = media && media.tagName === 'AUDIO';
        const candidates = audioOnly
            ? ['audio/webm;codecs=opus', 'audio/webm']
            : [
                'video/webm;codecs=vp9,opus',
                'video/webm;codecs=vp8,opus',
                'video/webm',
            ];
        return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
    }
    // PIPELINE_CORE_END

    globalThis.__happyCatchPipelineCore = {
        buildRanges,
        distributeRanges,
        sanitizeFileName,
        clampNumber,
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function uniqueId() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID();
        }
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    function mediaElementsFrom(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return [];
        return [...root.querySelectorAll('video, audio')].filter((media) => Boolean(
            media.currentSrc || media.src || media.readyState >= 1 ||
            Number.isFinite(media.duration) || media.videoWidth || media.videoHeight
        ));
    }

    function mediaElements() {
        return mediaElementsFrom(document);
    }

    async function waitForMedia(root = document, timeout = 30000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const list = mediaElementsFrom(root);
            if (list.length) return list;
            await sleep(250);
        }
        throw new Error('Медиаэлемент не найден');
    }

    async function waitForWindowMedia(opened, mediaIndex, timeout = 45000) {
        const deadline = Date.now() + timeout;
        let lastError = null;
        while (Date.now() < deadline) {
            if (!opened || opened.closed) throw new Error('Вкладка worker закрыта');
            try {
                const doc = opened.document;
                const list = mediaElementsFrom(doc);
                if (list.length) return list[mediaIndex] || list[0];
            } catch (error) {
                lastError = error;
            }
            await sleep(300);
        }
        if (lastError) throw new Error('Вкладка worker изолирована политикой сайта');
        throw new Error('Видео во вкладке worker не загрузилось');
    }

    function captureStream(media) {
        const fn = media.captureStream || media.mozCaptureStream || media.webkitCaptureStream;
        if (typeof fn !== 'function') throw new Error('Браузер не поддерживает captureStream()');
        return fn.call(media);
    }

    function once(target, event, timeout = 15000) {
        return new Promise((resolve, reject) => {
            let timer;
            const onEvent = (value) => finish(value, null);
            const finish = (value, error) => {
                clearTimeout(timer);
                target.removeEventListener(event, onEvent);
                error ? reject(error) : resolve(value);
            };
            target.addEventListener(event, onEvent, { once: true });
            timer = setTimeout(() => finish(null, new Error(`Таймаут события ${event}`)), timeout);
        });
    }

    async function seekMedia(media, time) {
        const duration = Number.isFinite(media.duration) ? media.duration : time;
        const target = Math.max(0, Math.min(duration, time));
        if (Math.abs(media.currentTime - target) < 0.15) return;
        const wait = once(media, 'seeked', 20000).catch(() => null);
        media.currentTime = target;
        await wait;
    }

    function recorderOptions(media, settings) {
        const mimeType = chooseMime(media);
        const options = {};
        if (mimeType) options.mimeType = mimeType;
        options.audioBitsPerSecond = settings.audioBits;
        if (media.tagName !== 'AUDIO') options.videoBitsPerSecond = settings.videoBits;
        return options;
    }

    async function recordRange(media, range, settings, runtime) {
        if (runtime.cancelled) throw new Error('Захват отменён');

        const previous = {
            time: media.currentTime,
            paused: media.paused,
            muted: media.muted,
            playbackRate: media.playbackRate,
            loop: media.loop,
        };
        let stream = null;
        let recorder = null;
        const chunks = [];

        try {
            media.loop = false;
            media.pause();
            media.playbackRate = 1;
            // Muting enables autoplay in background tabs. Per the capture-from-
            // element spec this does not mute the captured audio track.
            media.muted = true;
            await seekMedia(media, range.start);

            stream = captureStream(media);
            recorder = new MediaRecorder(stream, recorderOptions(media, settings));
            runtime.activeRecorder = recorder;

            const stopped = new Promise((resolve, reject) => {
                recorder.ondataavailable = (event) => {
                    if (event.data && event.data.size) chunks.push(event.data);
                };
                recorder.onerror = (event) => reject(event.error || new Error('MediaRecorder завершился с ошибкой'));
                recorder.onstop = resolve;
            });

            const expectedMs = Math.max(1000, (range.end - range.start) * 1000);
            const hardDeadline = Date.now() + expectedMs * 3 + 30000;
            recorder.start(1000);

            try {
                await media.play();
                while (!runtime.cancelled && media.currentTime < range.end - 0.08) {
                    if (Date.now() > hardDeadline) throw new Error(`Фрагмент ${range.index + 1}: видео не продвигается`);
                    if (media.ended) break;
                    await sleep(100);
                }
            } finally {
                if (recorder.state !== 'inactive') recorder.stop();
            }

            await stopped;
            if (runtime.cancelled) throw new Error('Захват отменён');

            const type = recorder.mimeType || chunks[0]?.type || chooseMime(media) || 'video/webm';
            const blob = new Blob(chunks, { type });
            if (!blob.size) throw new Error(`Фрагмент ${range.index + 1}: пустой результат`);
            return blob;
        } finally {
            runtime.activeRecorder = null;
            if (recorder && recorder.state !== 'inactive') {
                try { recorder.stop(); } catch (_) {}
            }
            if (stream) stream.getTracks().forEach((track) => track.stop());
            try { media.pause(); } catch (_) {}
            try { media.muted = previous.muted; } catch (_) {}
            try { media.playbackRate = previous.playbackRate; } catch (_) {}
            try { media.loop = previous.loop; } catch (_) {}
            if (!runtime.remote) {
                try { await seekMedia(media, previous.time); } catch (_) {}
                if (!previous.paused) media.play().catch(() => {});
            }
        }
    }

    async function recordWithRetry(media, range, settings, runtime, onAttempt) {
        let error;
        for (let attempt = 1; attempt <= settings.retries + 1; attempt++) {
            try {
                onAttempt && onAttempt(attempt);
                return await recordRange(media, range, settings, runtime);
            } catch (current) {
                error = current;
                if (runtime.cancelled) throw current;
                await sleep(500 * attempt);
            }
        }
        throw error || new Error(`Фрагмент ${range.index + 1} не записан`);
    }

    function createPanel() {
        if (document.getElementById('happyCatchFragmentPipeline')) return null;
        const root = document.createElement('section');
        root.id = 'happyCatchFragmentPipeline';
        root.innerHTML = `
            <style>
                #happyCatchFragmentPipeline{position:fixed;z-index:2147483647;top:18px;right:18px;width:320px;padding:14px;background:#111;color:#eee;border:1px solid #444;border-radius:10px;font:13px/1.35 system-ui,sans-serif;box-shadow:0 12px 38px #0008}
                #happyCatchFragmentPipeline *{box-sizing:border-box}
                #happyCatchFragmentPipeline h3{margin:0 0 10px;font-size:15px}
                #happyCatchFragmentPipeline label{display:grid;grid-template-columns:1fr 112px;gap:8px;align-items:center;margin:7px 0}
                #happyCatchFragmentPipeline input,#happyCatchFragmentPipeline select{width:100%;padding:5px 7px;background:#202020;color:#eee;border:1px solid #555;border-radius:5px}
                #happyCatchFragmentPipeline .actions{display:flex;gap:8px;margin-top:11px}
                #happyCatchFragmentPipeline button{padding:7px 10px;border:1px solid #666;border-radius:6px;background:#292929;color:#fff;cursor:pointer}
                #happyCatchFragmentPipeline button.primary{background:#f2f2f2;color:#111;border-color:#fff}
                #happyCatchFragmentPipeline button:disabled{opacity:.45;cursor:default}
                #happyCatchFragmentPipeline progress{width:100%;height:10px;margin-top:10px}
                #happyCatchFragmentPipeline .status{margin-top:8px;white-space:pre-wrap;max-height:90px;overflow:auto;color:#bbb}
                #happyCatchFragmentPipeline .close{position:absolute;top:7px;right:8px;padding:2px 7px;border:0;background:transparent;color:#aaa}
            </style>
            <button class="close" title="Закрыть">×</button>
            <h3>Фрагментный захват</h3>
            <label>Медиа <select data-field="media"></select></label>
            <label>Начало, сек <input data-field="start" type="number" min="0" step="1" value="0"></label>
            <label>Конец, сек <input data-field="end" type="number" min="0" step="1"></label>
            <label>Фрагмент, сек <input data-field="chunk" type="number" min="15" max="900" step="5" value="120"></label>
            <label>Вкладки <input data-field="workers" type="number" min="1" max="6" step="1" value="2"></label>
            <label>Повторы <input data-field="retries" type="number" min="0" max="3" step="1" value="1"></label>
            <label>Видео, Mbps <input data-field="videoBits" type="number" min="1" max="24" step="0.5" value="5"></label>
            <label>Аудио, kbps <input data-field="audioBits" type="number" min="64" max="320" step="32" value="160"></label>
            <label>Надёжная склейка <input data-field="transcode" type="checkbox" checked></label>
            <div class="actions">
                <button class="primary" data-action="start">Запустить</button>
                <button data-action="stop" disabled>Отменить</button>
            </div>
            <progress max="1" value="0"></progress>
            <div class="status">Готово к запуску.</div>
        `;
        document.documentElement.appendChild(root);
        return root;
    }

    function fillMedia(panel, list) {
        const select = panel.querySelector('[data-field="media"]');
        select.innerHTML = '';
        list.forEach((media, index) => {
            const source = media.currentSrc || media.src || `${media.tagName.toLowerCase()} ${index + 1}`;
            const label = source.split(/[?#]/)[0].split('/').pop() || `${media.tagName.toLowerCase()} ${index + 1}`;
            select.add(new Option(label, String(index)));
        });
        const duration = list[0] && Number.isFinite(list[0].duration) ? list[0].duration : 0;
        panel.querySelector('[data-field="end"]').value = duration ? String(Math.floor(duration)) : '';
    }

    function postToFfmpeg(blobs, settings, taskId) {
        const urls = blobs.map((blob) => URL.createObjectURL(blob));
        const files = urls.map((data, index) => ({
            data,
            type: blobs[index].type || 'video/webm',
            name: `${String(index).padStart(5, '0')}.webm`,
            index,
        }));
        window.postMessage({
            action: 'catCatchFFmpeg',
            use: 'merge',
            files,
            quantity: files.length,
            taskId,
            title: settings.title,
            transcode: settings.transcode,
            concatOrder: files.map((file) => file.name),
        }, location.origin);
        setTimeout(() => urls.forEach((url) => URL.revokeObjectURL(url)), 10 * 60 * 1000);
    }

    function notifyClosed() {
        globalThis.__happyCatchFragmentPipelineLoaded = false;
        window.postMessage({ action: 'catCatchCloseScript', script: 'recorder.js' }, location.origin);
    }

    async function runCoordinator(panel, list) {
        const field = (name) => panel.querySelector(`[data-field="${name}"]`);
        const mediaIndex = Number(field('media').value) || 0;
        const media = list[mediaIndex];
        if (!media) throw new Error('Выбранное медиа не найдено');
        if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error('Не удалось определить длительность');

        const start = clampNumber(field('start').value, 0, media.duration, 0);
        const end = clampNumber(field('end').value, start + 0.1, media.duration, media.duration);
        const settings = {
            chunkSeconds: clampNumber(field('chunk').value, 15, 900, 120),
            workers: Math.floor(clampNumber(field('workers').value, 1, 6, 2)),
            retries: Math.floor(clampNumber(field('retries').value, 0, 3, 1)),
            videoBits: Math.floor(clampNumber(field('videoBits').value, 1, 24, 5) * 1000000),
            audioBits: Math.floor(clampNumber(field('audioBits').value, 64, 320, 160) * 1000),
            transcode: field('transcode').checked,
            title: sanitizeFileName(document.title),
        };
        const ranges = buildRanges(start, end, settings.chunkSeconds);
        if (!ranges.length) throw new Error('Пустой диапазон');
        settings.workers = Math.min(settings.workers, ranges.length);

        const taskId = uniqueId();
        const assignments = distributeRanges(ranges, settings.workers);
        const fragments = new Array(ranges.length);
        const workerWindows = [];
        const runtimes = Array.from({ length: settings.workers }, (_, index) => ({
            cancelled: false,
            activeRecorder: null,
            remote: index !== 0,
        }));
        let completed = 0;

        const status = panel.querySelector('.status');
        const progress = panel.querySelector('progress');
        const startButton = panel.querySelector('[data-action="start"]');
        const stopButton = panel.querySelector('[data-action="stop"]');
        startButton.disabled = true;
        stopButton.disabled = false;
        progress.value = 0;

        const report = (text) => { status.textContent = text; };
        const accept = (range, blob, workerId) => {
            if (fragments[range.index]) return;
            fragments[range.index] = blob;
            completed++;
            progress.value = completed / ranges.length;
            report(`Получено ${completed}/${ranges.length}: фрагмент ${range.index + 1}, вкладка ${workerId + 1}.`);
        };

        for (let workerId = 1; workerId < settings.workers; workerId++) {
            const opened = window.open(location.href, `_happy_catch_${taskId}_${workerId}`);
            if (opened) workerWindows[workerId] = opened;
        }

        const cancel = () => {
            runtimes.forEach((runtime) => {
                runtime.cancelled = true;
                if (runtime.activeRecorder && runtime.activeRecorder.state !== 'inactive') {
                    try { runtime.activeRecorder.stop(); } catch (_) {}
                }
            });
            workerWindows.forEach((opened) => { try { opened && opened.close(); } catch (_) {} });
        };
        stopButton.onclick = cancel;

        const runAssignment = async (workerId) => {
            const runtime = runtimes[workerId];
            let targetMedia = media;
            if (workerId > 0) {
                const opened = workerWindows[workerId];
                if (!opened) throw new Error(`Вкладка ${workerId + 1} заблокирована браузером`);
                targetMedia = await waitForWindowMedia(opened, mediaIndex);
            }
            for (const range of assignments[workerId]) {
                const blob = await recordWithRetry(targetMedia, range, settings, runtime, (attempt) => {
                    report(`Вкладка ${workerId + 1}: фрагмент ${range.index + 1}/${ranges.length}, попытка ${attempt}.`);
                });
                accept(range, blob, workerId);
            }
        };

        try {
            const results = await Promise.allSettled(
                Array.from({ length: settings.workers }, (_, workerId) => runAssignment(workerId)),
            );
            results.forEach((result, workerId) => {
                if (result.status === 'rejected' && !runtimes[workerId].cancelled) {
                    report(`Вкладка ${workerId + 1}: ${String(result.reason && result.reason.message || result.reason)}. Пропуски заберёт основной таб.`);
                }
            });

            if (runtimes[0].cancelled) throw new Error('Захват отменён');
            const missing = ranges.filter((range) => !fragments[range.index]);
            for (const range of missing) {
                report(`Повтор в основном табе: фрагмент ${range.index + 1}/${ranges.length}.`);
                const blob = await recordWithRetry(media, range, settings, runtimes[0]);
                accept(range, blob, 0);
            }

            if (fragments.some((blob) => !blob)) throw new Error('Не все фрагменты записаны');
            report('Все фрагменты готовы. Передаю в FFmpeg на склейку…');
            postToFfmpeg(fragments, settings, taskId);
            progress.value = 1;
            report(`Передано ${fragments.length} фрагментов в строгом порядке. FFmpeg собирает итоговый файл.`);
        } finally {
            workerWindows.forEach((opened) => { try { opened && opened.close(); } catch (_) {} });
            startButton.disabled = false;
            stopButton.disabled = true;
            stopButton.onclick = null;
        }
    }

    async function bootCoordinator() {
        const list = await waitForMedia(document, 30000).catch(() => []);
        const panel = createPanel();
        if (!panel) return;
        fillMedia(panel, list);
        if (!list.length) {
            panel.querySelector('.status').textContent = 'Медиа не найдено. Запустите recorder после появления плеера.';
            panel.querySelector('[data-action="start"]').disabled = true;
        }

        panel.querySelector('.close').onclick = () => {
            const stopButton = panel.querySelector('[data-action="stop"]');
            if (!stopButton.disabled) stopButton.click();
            panel.remove();
            notifyClosed();
        };
        panel.querySelector('[data-action="start"]').onclick = async () => {
            try {
                const current = mediaElements();
                fillMedia(panel, current);
                await runCoordinator(panel, current);
            } catch (error) {
                panel.querySelector('.status').textContent = String(error && error.message || error);
                panel.querySelector('[data-action="start"]').disabled = false;
                panel.querySelector('[data-action="stop"]').disabled = true;
            }
        };
    }

    bootCoordinator().catch((error) => console.error('[Happy Catch] pipeline failed', error));
})();
