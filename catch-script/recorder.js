(() => {
    'use strict';

    if (globalThis.__happyCatchFragmentPipelineLoaded) return;
    globalThis.__happyCatchFragmentPipelineLoaded = true;

    const WORKER_PARAM = '__happy_catch_worker';
    const PIPELINE_VERSION = 1;
    const workerToken = new URL(location.href).searchParams.get(WORKER_PARAM);

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
        if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    function mediaElements() {
        return [...document.querySelectorAll('video, audio')].filter((media) => {
            return Boolean(
                media.currentSrc || media.src || media.readyState >= 1 ||
                Number.isFinite(media.duration) || media.videoWidth || media.videoHeight
            );
        });
    }

    async function waitForMedia(timeout = 30000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const list = mediaElements();
            if (list.length) return list;
            await sleep(250);
        }
        throw new Error('Медиаэлемент не найден');
    }

    function captureStream(media) {
        const fn = media.captureStream || media.mozCaptureStream || media.webkitCaptureStream;
        if (typeof fn !== 'function') throw new Error('Браузер не поддерживает captureStream()');
        return fn.call(media);
    }

    function once(target, event, timeout = 15000) {
        return new Promise((resolve, reject) => {
            let timer;
            const done = (value, error) => {
                clearTimeout(timer);
                target.removeEventListener(event, onEvent);
                error ? reject(error) : resolve(value);
            };
            const onEvent = (value) => done(value);
            target.addEventListener(event, onEvent, { once: true });
            timer = setTimeout(() => done(null, new Error(`Таймаут события ${event}`)), timeout);
        });
    }

    async function seekMedia(media, time) {
        const target = Math.max(0, Math.min(Number.isFinite(media.duration) ? media.duration : time, time));
        if (Math.abs(media.currentTime - target) < 0.15) return;
        const wait = once(media, 'seeked', 20000).catch(() => null);
        media.currentTime = target;
        await wait;
    }

    function recorderOptions(media, settings) {
        const mimeType = chooseMime(media);
        const options = {};
        if (mimeType) options.mimeType = mimeType;
        if (media.tagName === 'AUDIO') {
            options.audioBitsPerSecond = settings.audioBits;
        } else {
            options.audioBitsPerSecond = settings.audioBits;
            options.videoBitsPerSecond = settings.videoBits;
        }
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

        media.loop = false;
        media.pause();
        media.playbackRate = 1;
        media.muted = true;
        await seekMedia(media, range.start);

        const stream = captureStream(media);
        const chunks = [];
        const recorder = new MediaRecorder(stream, recorderOptions(media, settings));
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
                if (Date.now() > hardDeadline) throw new Error(`Фрагмент ${range.index}: видео не продвигается`);
                if (media.ended) break;
                await sleep(100);
            }
        } finally {
            if (recorder.state !== 'inactive') recorder.stop();
        }

        await stopped;
        runtime.activeRecorder = null;
        stream.getTracks().forEach((track) => track.stop());

        media.pause();
        media.muted = previous.muted;
        media.playbackRate = previous.playbackRate;
        media.loop = previous.loop;
        if (!runtime.workerMode) {
            try { await seekMedia(media, previous.time); } catch (_) {}
            if (!previous.paused) media.play().catch(() => {});
        }

        if (runtime.cancelled) throw new Error('Захват отменён');
        const type = recorder.mimeType || chunks[0]?.type || chooseMime(media) || 'video/webm';
        const blob = new Blob(chunks, { type });
        if (!blob.size) throw new Error(`Фрагмент ${range.index}: пустой результат`);
        return blob;
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
        throw error || new Error(`Фрагмент ${range.index} не записан`);
    }

    function parseWorkerToken(token) {
        if (!token) return null;
        const [taskId, workerId] = token.split(':');
        if (!taskId || !/^\d+$/.test(workerId || '')) return null;
        return { taskId, workerId: Number(workerId) };
    }

    async function runWorker(token) {
        const parsed = parseWorkerToken(token);
        if (!parsed || typeof BroadcastChannel !== 'function') return;

        const nonce = uniqueId();
        const channel = new BroadcastChannel(`happy-catch:${parsed.taskId}`);
        const runtime = { cancelled: false, activeRecorder: null, workerMode: true };
        let bound = false;

        channel.onmessage = async ({ data }) => {
            if (!data || data.version !== PIPELINE_VERSION || data.taskId !== parsed.taskId) return;
            if (data.type === 'cancel') {
                runtime.cancelled = true;
                if (runtime.activeRecorder && runtime.activeRecorder.state !== 'inactive') runtime.activeRecorder.stop();
                return;
            }
            if (data.type !== 'assign' || data.workerId !== parsed.workerId || data.nonce !== nonce || bound) return;
            bound = true;

            try {
                const list = await waitForMedia(45000);
                const media = list[data.mediaIndex] || list[0];
                if (!media) throw new Error('Видео для worker не найдено');

                for (const range of data.ranges) {
                    const blob = await recordWithRetry(media, range, data.settings, runtime, (attempt) => {
                        channel.postMessage({
                            version: PIPELINE_VERSION,
                            taskId: parsed.taskId,
                            type: 'progress',
                            workerId: parsed.workerId,
                            index: range.index,
                            attempt,
                        });
                    });
                    channel.postMessage({
                        version: PIPELINE_VERSION,
                        taskId: parsed.taskId,
                        type: 'fragment',
                        workerId: parsed.workerId,
                        index: range.index,
                        start: range.start,
                        end: range.end,
                        blob,
                    });
                }
                channel.postMessage({
                    version: PIPELINE_VERSION,
                    taskId: parsed.taskId,
                    type: 'worker-done',
                    workerId: parsed.workerId,
                });
            } catch (error) {
                channel.postMessage({
                    version: PIPELINE_VERSION,
                    taskId: parsed.taskId,
                    type: 'worker-error',
                    workerId: parsed.workerId,
                    error: String(error && error.message || error),
                });
            }
        };

        try {
            const list = await waitForMedia(45000);
            if (!list.length) throw new Error('Медиаэлемент не найден');
            channel.postMessage({
                version: PIPELINE_VERSION,
                taskId: parsed.taskId,
                type: 'ready',
                workerId: parsed.workerId,
                nonce,
                mediaCount: list.length,
            });
        } catch (error) {
            channel.postMessage({
                version: PIPELINE_VERSION,
                taskId: parsed.taskId,
                type: 'worker-error',
                workerId: parsed.workerId,
                error: String(error && error.message || error),
            });
        }
    }

    function workerUrl(taskId, workerId) {
        const url = new URL(location.href);
        url.searchParams.set(WORKER_PARAM, `${taskId}:${workerId}`);
        return url.href;
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

    async function runCoordinator(panel, list) {
        if (typeof BroadcastChannel !== 'function') throw new Error('BroadcastChannel не поддерживается');
        const fields = (name) => panel.querySelector(`[data-field="${name}"]`);
        const mediaIndex = Number(fields('media').value) || 0;
        const media = list[mediaIndex];
        if (!media) throw new Error('Выбранное медиа не найдено');
        if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error('Не удалось определить длительность');

        const start = clampNumber(fields('start').value, 0, media.duration, 0);
        const end = clampNumber(fields('end').value, start + 0.1, media.duration, media.duration);
        const settings = {
            chunkSeconds: clampNumber(fields('chunk').value, 15, 900, 120),
            workers: Math.floor(clampNumber(fields('workers').value, 1, 6, 2)),
            retries: Math.floor(clampNumber(fields('retries').value, 0, 3, 1)),
            videoBits: Math.floor(clampNumber(fields('videoBits').value, 1, 24, 5) * 1000000),
            audioBits: Math.floor(clampNumber(fields('audioBits').value, 64, 320, 160) * 1000),
            transcode: fields('transcode').checked,
            title: sanitizeFileName(document.title),
        };
        const ranges = buildRanges(start, end, settings.chunkSeconds);
        if (!ranges.length) throw new Error('Пустой диапазон');
        settings.workers = Math.min(settings.workers, ranges.length);

        const taskId = uniqueId();
        const channel = new BroadcastChannel(`happy-catch:${taskId}`);
        const assignments = distributeRanges(ranges, settings.workers);
        const fragments = new Array(ranges.length);
        const remoteDone = new Set();
        const readyWorkers = new Set();
        const boundNonce = new Map();
        const workerWindows = [];
        const runtime = { cancelled: false, activeRecorder: null, workerMode: false };
        let completed = 0;

        const status = panel.querySelector('.status');
        const progress = panel.querySelector('progress');
        const startButton = panel.querySelector('[data-action="start"]');
        const stopButton = panel.querySelector('[data-action="stop"]');
        startButton.disabled = true;
        stopButton.disabled = false;
        progress.value = 0;

        const report = (text) => { status.textContent = text; };
        const receive = ({ data }) => {
            if (!data || data.version !== PIPELINE_VERSION || data.taskId !== taskId) return;
            if (data.type === 'ready' && data.workerId > 0 && !boundNonce.has(data.workerId)) {
                boundNonce.set(data.workerId, data.nonce);
                readyWorkers.add(data.workerId);
                channel.postMessage({
                    version: PIPELINE_VERSION,
                    taskId,
                    type: 'assign',
                    workerId: data.workerId,
                    nonce: data.nonce,
                    mediaIndex,
                    ranges: assignments[data.workerId],
                    settings,
                });
                report(`Worker ${data.workerId + 1}/${settings.workers} подключён.`);
                return;
            }
            if (data.type === 'fragment' && !fragments[data.index]) {
                fragments[data.index] = data.blob;
                completed++;
                progress.value = completed / ranges.length;
                report(`Получено ${completed}/${ranges.length}: фрагмент ${data.index + 1}.`);
                return;
            }
            if (data.type === 'worker-done') remoteDone.add(data.workerId);
            if (data.type === 'worker-error') {
                remoteDone.add(data.workerId);
                report(`Worker ${data.workerId + 1}: ${data.error}. Пропуски заберёт основной таб.`);
            }
        };
        channel.onmessage = receive;

        for (let workerId = 1; workerId < settings.workers; workerId++) {
            const opened = window.open(workerUrl(taskId, workerId), `_happy_catch_${taskId}_${workerId}`);
            if (opened) workerWindows.push(opened);
        }

        const cancel = () => {
            runtime.cancelled = true;
            channel.postMessage({ version: PIPELINE_VERSION, taskId, type: 'cancel' });
            if (runtime.activeRecorder && runtime.activeRecorder.state !== 'inactive') runtime.activeRecorder.stop();
            workerWindows.forEach((opened) => { try { opened.close(); } catch (_) {} });
        };
        stopButton.onclick = cancel;

        try {
            for (const range of assignments[0]) {
                const blob = await recordWithRetry(media, range, settings, runtime, (attempt) => {
                    report(`Основной таб: фрагмент ${range.index + 1}/${ranges.length}, попытка ${attempt}.`);
                });
                if (!fragments[range.index]) {
                    fragments[range.index] = blob;
                    completed++;
                    progress.value = completed / ranges.length;
                }
            }

            const remoteDeadline = Date.now() + Math.max(60000, (end - start) * 2500);
            while (!runtime.cancelled && completed < ranges.length && Date.now() < remoteDeadline) {
                await sleep(300);
            }

            const missing = ranges.filter((range) => !fragments[range.index]);
            for (const range of missing) {
                if (runtime.cancelled) break;
                report(`Повтор в основном табе: фрагмент ${range.index + 1}/${ranges.length}.`);
                const blob = await recordWithRetry(media, range, settings, runtime);
                fragments[range.index] = blob;
                completed++;
                progress.value = completed / ranges.length;
            }

            if (runtime.cancelled) throw new Error('Захват отменён');
            if (fragments.some((blob) => !blob)) throw new Error('Не все фрагменты записаны');

            report('Все фрагменты готовы. Передаю в FFmpeg на склейку…');
            postToFfmpeg(fragments, settings, taskId);
            progress.value = 1;
            report(`Передано ${fragments.length} фрагментов в строгом порядке. FFmpeg собирает итоговый файл.`);
        } finally {
            channel.postMessage({ version: PIPELINE_VERSION, taskId, type: 'cancel' });
            channel.close();
            workerWindows.forEach((opened) => { try { opened.close(); } catch (_) {} });
            startButton.disabled = false;
            stopButton.disabled = true;
            stopButton.onclick = null;
        }
    }

    async function bootCoordinator() {
        const list = await waitForMedia(30000).catch(() => []);
        if (!list.length) return;
        const panel = createPanel();
        if (!panel) return;
        fillMedia(panel, list);

        panel.querySelector('.close').onclick = () => panel.remove();
        panel.querySelector('[data-action="start"]').onclick = async () => {
            try {
                await runCoordinator(panel, mediaElements());
            } catch (error) {
                panel.querySelector('.status').textContent = String(error && error.message || error);
                panel.querySelector('[data-action="start"]').disabled = false;
                panel.querySelector('[data-action="stop"]').disabled = true;
            }
        };
    }

    if (workerToken) {
        runWorker(workerToken).catch((error) => console.error('[Happy Catch] worker failed', error));
    } else {
        bootCoordinator().catch((error) => console.error('[Happy Catch] pipeline failed', error));
    }
})();
