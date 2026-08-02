// Auto-load the recorder pipeline in tabs opened as fragment workers.
// The regular recorder is still injected from the Cat Catch UI; only worker tabs
// use this bootstrap path.
(() => {
    const params = new URL(location.href).searchParams;
    if (!params.has('__happy_catch_worker')) return;

    const inject = (path) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL(path);
        script.onload = () => { script.remove(); resolve(); };
        script.onerror = () => { script.remove(); reject(new Error(`Cannot load ${path}`)); };
        (document.head || document.documentElement).appendChild(script);
    });

    (async () => {
        try {
            await inject('catch-script/i18n.js');
            await inject('catch-script/recorder.js');
        } catch (error) {
            console.error('[Happy Catch] worker bootstrap failed', error);
        }
    })();
})();
