'use strict';

const elements = {
  media: document.querySelector('#media'),
  start: document.querySelector('#start'),
  end: document.querySelector('#end'),
  step: document.querySelector('#step'),
  minDwell: document.querySelector('#minDwell'),
  quiet: document.querySelector('#quiet'),
  maxDwell: document.querySelector('#maxDwell'),
  startCapture: document.querySelector('#startCapture'),
  stopCapture: document.querySelector('#stopCapture'),
  refresh: document.querySelector('#refresh'),
  progress: document.querySelector('#progress'),
  status: document.querySelector('#status'),
};

let activeTab = null;
let media = [];
let pollTimer = null;

function setStatus(text) {
  elements.status.textContent = text;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) throw new Error('Откройте страницу с видео');
  return tab;
}

async function probe() {
  activeTab = await getActiveTab();
  setStatus('Ищу HTML5-плеер во всех фреймах…');
  const response = await chrome.runtime.sendMessage({ type: 'PROBE_TAB', tabId: activeTab.id });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось проверить страницу');
  media = response.media || [];
  elements.media.innerHTML = '';
  for (const item of media) {
    const duration = item.duration ? ` · ${Math.round(item.duration)} сек` : '';
    const size = item.width && item.height ? ` · ${item.width}×${item.height}` : '';
    elements.media.add(new Option(`${item.label || item.tag}${duration}${size}`, item.key));
  }
  if (!media.length) {
    elements.startCapture.disabled = true;
    setStatus('HTML5-плеер не найден. Запустите видео и нажмите «Обновить».');
    return;
  }
  elements.startCapture.disabled = false;
  const selected = media[0];
  elements.end.value = selected.duration ? String(Math.floor(selected.duration)) : '';
  setStatus(`Найдено плееров: ${media.length}. Готово к запуску.`);
}

function selectedMedia() {
  return media.find((item) => item.key === elements.media.value) || media[0];
}

elements.media.addEventListener('change', () => {
  const selected = selectedMedia();
  if (selected?.duration) elements.end.value = String(Math.floor(selected.duration));
});

async function startCapture() {
  const selected = selectedMedia();
  if (!selected || !activeTab) throw new Error('Плеер не выбран');
  const response = await chrome.runtime.sendMessage({
    type: 'START_CAPTURE',
    tabId: activeTab.id,
    mediaKey: selected.key,
    settings: {
      start: Number(elements.start.value),
      end: Number(elements.end.value || selected.duration),
      step: Number(elements.step.value),
      minDwellMs: Number(elements.minDwell.value),
      quietMs: Number(elements.quiet.value),
      maxDwellMs: Number(elements.maxDwell.value),
    },
  });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось запустить захват');
  elements.startCapture.disabled = true;
  elements.stopCapture.disabled = false;
  setStatus('Перематываю плеер и собираю сетевые фрагменты…');
  startPolling();
}

async function stopCapture() {
  if (!activeTab) return;
  await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', tabId: activeTab.id });
  elements.stopCapture.disabled = true;
  elements.startCapture.disabled = false;
  setStatus('Захват остановлен.');
}

async function updateStatus() {
  if (!activeTab) return;
  const response = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_STATUS', tabId: activeTab.id }).catch(() => null);
  const session = response?.session;
  if (!session) return;
  elements.progress.value = Number(session.progress || 0);
  const position = Number(session.currentPosition || 0).toFixed(1);
  const summary = `Статус: ${session.status}\nПозиция: ${position} сек\nЗапросов: ${session.requestCount} · медиа-кандидатов: ${session.usefulCount}`;
  setStatus(session.error ? `${summary}\nОшибка: ${session.error}` : summary);
  const terminal = ['done', 'error', 'cancelled', 'assembling', 'captured'].includes(session.status);
  if (terminal) {
    elements.startCapture.disabled = false;
    elements.stopCapture.disabled = true;
    if (session.status === 'assembling') setStatus(`${summary}\nОткрыта страница сборки и скачивания.`);
    stopPolling();
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(updateStatus, 500);
  updateStatus();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

elements.startCapture.addEventListener('click', () => startCapture().catch((error) => setStatus(error.message)));
elements.stopCapture.addEventListener('click', () => stopCapture().catch((error) => setStatus(error.message)));
elements.refresh.addEventListener('click', () => probe().catch((error) => setStatus(error.message)));

probe().then(startPolling).catch((error) => setStatus(error.message));
