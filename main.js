// Browser bootstrap only. No app state, service worker or storage is deleted here.
export const STARTUP_TIMEOUT_MS = 120000;

export function readRuntimeVersion(source) {
    const match = source.match(/\/\*json-start\*\/([\s\S]*?)\/\*json-end\*\//);
    if (!match) throw new Error('找不到這份發布檔的 runtime 資源清單。');
    const config = JSON.parse(match[1]);
    const hash = config?.resources?.hash;
    if (typeof hash !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(hash)) {
        throw new Error('發布檔的 runtime 資源識別碼無效。');
    }
    return hash;
}

export function runtimeUrl(base, hash) {
    const url = new URL('_framework/dotnet.js', base);
    url.searchParams.set('strforgeBuild', hash);
    return url.href;
}

// A timeout stops waiting, not the .NET runtime itself. Retry always reloads the
// whole document; it never creates a second runtime inside the current page.
export async function withDeadline(operation, timeoutMs, onTimeout) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { onTimeout?.(); }
            finally { reject(new Error('啟動等候超過 120 秒。可重新載入；此操作不會清除保存資料。')); }
        }, timeoutMs);
    });
    try { return await Promise.race([operation, timeout]); }
    finally { clearTimeout(timer); }
}

function createLoadingUi() {
    const overlay = document.querySelector('.loading');
    if (!overlay) throw new Error('缺少啟動畫面 .loading。');
    overlay.style.pointerEvents = 'auto';
    overlay.style.zIndex = '10000';
    overlay.dataset.state = 'loading';
    const panel = document.createElement('section');
    panel.style.cssText = 'width:min(380px,86vw);text-align:center;line-height:1.6';
    const title = document.createElement('strong');
    title.textContent = 'StrForge 載入中…';
    const stage = document.createElement('div');
    stage.id = 'strforge-startup-stage';
    const progress = document.createElement('div');
    progress.id = 'strforge-startup-progress';
    const hint = document.createElement('p');
    hint.style.cssText = 'font-size:14px;font-weight:400;color:#aebed0';
    hint.textContent = '首次開啟需要下載程式資源。Safari 與主畫面入口可能各自需要下載。';
    const retry = document.createElement('button');
    retry.id = 'strforge-startup-retry';
    retry.type = 'button';
    retry.textContent = '重新載入（保留資料）';
    retry.hidden = true;
    retry.style.cssText = 'padding:12px 18px;background:#263c54;color:#fff;border:1px solid #546b82;border-radius:8px;font:inherit;touch-action:manipulation';
    retry.addEventListener('click', () => {
        retry.disabled = true;
        const url = new URL(location.href);
        url.searchParams.set('strforgeRetry', Date.now().toString());
        location.replace(url.href);
    });
    const error = document.createElement('pre');
    error.id = 'strforge-startup-error';
    error.hidden = true;
    error.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;font:12px/1.5 system-ui;max-height:35vh;overflow:auto;user-select:text;touch-action:pan-y';
    panel.append(title, stage, progress, hint, retry, error);
    overlay.replaceChildren(panel);
    return { overlay, title, stage, progress, hint, retry, error };
}

async function start() {
    const ui = createLoadingUi();
    const diagnostics = globalThis.strforgeStartup = {
        stage: '檢查啟動資源', status: 'loading', startedAt: new Date().toISOString(),
        runtimeHash: null, completedResources: 0, totalResources: 0, readyMs: null
    };
    const started = performance.now();
    const controller = new AbortController();
    let settled = false;
    const setStage = value => {
        if (!settled) { diagnostics.stage = value; ui.stage.textContent = value; }
    };
    const clock = setInterval(() => {
        if (settled) return;
        const seconds = Math.floor((performance.now() - started) / 1000);
        ui.progress.textContent = `已取得 ${diagnostics.completedResources} / ${diagnostics.totalResources || '?'} 個資源 · ${seconds} 秒`;
        if (seconds >= 15) {
            ui.hint.textContent = '載入較久，可能仍在下載或初始化；請保持畫面開啟。無需刪除主畫面圖示或網站資料。';
            ui.retry.hidden = false;
        }
    }, 500);
    setStage(diagnostics.stage);
    try {
        const operation = (async () => {
            const base = new URL('./', import.meta.url);
            // Revalidate the small fixed-name entry. Only its content identifier
            // changes module URLs; hashed WASM remains cacheable across launches.
            const response = await fetch(new URL('_framework/dotnet.js', base), {
                cache: 'no-cache', credentials: 'same-origin', signal: controller.signal
            });
            if (!response.ok) throw new Error(`啟動資源 HTTP ${response.status}：_framework/dotnet.js`);
            const hash = readRuntimeVersion(await response.text());
            diagnostics.runtimeHash = hash;
            if (settled) return;
            setStage('下載並初始化 .NET');
            const { dotnet } = await import(runtimeUrl(base, hash));
            if (settled) return;
            const runtime = await dotnet
                .withDiagnosticTracing(false)
                .withApplicationArgumentsFromQuery()
                .withModuleConfig({ onDownloadResourceProgress: (loaded, total) => {
                    if (settled) return;
                    diagnostics.completedResources = loaded;
                    diagnostics.totalResources = total;
                } })
                .create();
            if (settled) return;
            const config = runtime.getConfig();
            if (config.resources?.hash !== hash) {
                throw new Error('網站正在更新，兩次取得的資源清單不同。請按重新載入，保存資料不受影響。');
            }
            setStage('建立畫面並還原保存資料');
            await runtime.runMain(config.mainAssemblyName, [globalThis.location.href]);
        })();
        await withDeadline(operation, STARTUP_TIMEOUT_MS, () => {
            settled = true;
            controller.abort();
        });
        settled = true;
        diagnostics.status = 'ready';
        diagnostics.readyMs = Math.round(performance.now() - started);
        ui.overlay.remove();
        const url = new URL(location.href);
        if (url.searchParams.has('strforgeRetry')) {
            url.searchParams.delete('strforgeRetry');
            try { history.replaceState(history.state, '', url.href); }
            catch (error) { console.debug('StrForge retry URL cleanup unavailable', error); }
        }
        console.info('StrForge startup ready', {
            readyMs: diagnostics.readyMs, runtimeHash: diagnostics.runtimeHash
        });
    } catch (cause) {
        settled = true;
        controller.abort();
        diagnostics.status = 'error';
        diagnostics.error = String(cause?.message || cause).slice(0, 2000);
        ui.overlay.dataset.state = 'error';
        ui.title.textContent = 'StrForge 啟動未完成';
        ui.stage.textContent = `停止階段：${diagnostics.stage}`;
        ui.hint.textContent = '已保留網站保存資料。可按重新載入；無需刪除圖示或清除網站資料。';
        ui.error.hidden = false;
        ui.error.textContent = diagnostics.error;
        ui.retry.hidden = false;
        console.error('StrForge startup failed', { stage: diagnostics.stage, error: diagnostics.error });
    } finally { clearInterval(clock); }
}

if (typeof document !== 'undefined') void start();
