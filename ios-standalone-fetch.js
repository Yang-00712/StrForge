(() => {
    const config = globalThis.strforgeStandaloneFetchConfig || {};
    const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 20000;
    const retryDelayMs = Number.isFinite(config.retryDelayMs) && config.retryDelayMs >= 0 ? config.retryDelayMs : 150;
    const maxParallel = Number.isInteger(config.maxParallel) && config.maxParallel > 0 ? config.maxParallel : 6;
    const state = globalThis.strforgeStandaloneFetch = {
        enabled: false,
        maxParallel,
        timeoutMs,
        active: 0,
        queued: 0,
        retries: 0,
        timeouts: 0,
        pending: [],
        lastTimeouts: []
    };

    const userAgent = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const isIos = /iPad|iPhone|iPod/i.test(userAgent) ||
        (platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1);
    const standalone = navigator.standalone === true ||
        globalThis.matchMedia?.('(display-mode: standalone)')?.matches === true;

    if (!isIos || !standalone || typeof globalThis.fetch !== 'function') return;

    state.enabled = true;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const queue = [];
    const pending = new Map();
    let active = 0;
    let nextRequestId = 1;

    const resourceName = input => {
        try {
            const raw = input instanceof Request ? input.url : String(input);
            const url = new URL(raw, location.href);
            return decodeURIComponent(url.pathname.split('/').pop() || url.pathname);
        } catch {
            return 'unknown';
        }
    };

    const renderDiagnostics = () => {
        const progress = document.getElementById('strforge-startup-progress');
        if (!progress) return;
        let detail = document.getElementById('strforge-ios-fetch-detail');
        if (!detail) {
            detail = document.createElement('div');
            detail.id = 'strforge-ios-fetch-detail';
            detail.style.cssText = 'margin-top:8px;font-size:12px;line-height:1.45;color:#91a6bd;overflow-wrap:anywhere';
            progress.insertAdjacentElement('afterend', detail);
        }
        const pendingNames = state.pending.slice(0, 3).map(item => `${item.name} (${Math.ceil(item.ageMs / 1000)}s)`).join('、');
        const timeoutNames = state.lastTimeouts.slice(-2).map(item => item.name).join('、');
        let text = `iPhone下載保護：啟用｜進行中 ${state.active}｜排隊 ${state.queued}｜重試 ${state.retries}`;
        if (pendingNames) text += `｜等待：${pendingNames}`;
        if (timeoutNames) text += `｜曾逾時：${timeoutNames}`;
        detail.textContent = text;
    };

    const publish = () => {
        state.active = active;
        state.queued = queue.length;
        state.pending = [...pending.values()]
            .sort((a, b) => a.startedAt - b.startedAt)
            .map(item => ({ name: item.name, attempt: item.attempt, ageMs: Math.max(0, Date.now() - item.startedAt) }));
        renderDiagnostics();
    };

    const diagnosticsClock = setInterval(() => {
        if (!state.enabled) {
            clearInterval(diagnosticsClock);
            return;
        }
        publish();
    }, 1000);

    const acquire = () => {
        if (active < state.maxParallel) {
            active++;
            publish();
            return Promise.resolve();
        }
        return new Promise(resolve => {
            queue.push(resolve);
            publish();
        }).then(() => {
            active++;
            publish();
        });
    };

    const release = () => {
        active = Math.max(0, active - 1);
        const next = queue.shift();
        publish();
        next?.();
    };

    const shouldProtect = input => {
        try {
            const raw = input instanceof Request ? input.url : String(input);
            const url = new URL(raw, location.href);
            return url.origin === location.origin &&
                url.pathname.includes('/_framework/') &&
                /\.(wasm|dat)$/i.test(url.pathname);
        } catch {
            return false;
        }
    };

    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    const abortError = signal => {
        if (signal?.reason instanceof Error) return signal.reason;
        try { return new DOMException('The operation was aborted.', 'AbortError'); }
        catch { return new Error('The operation was aborted.'); }
    };

    const fetchWithHardDeadline = async (input, init, attempt, name, requestId) => {
        const controller = new AbortController();
        const callerSignal = init?.signal;
        const relayAbort = () => controller.abort(callerSignal?.reason);
        let timeoutHandle;
        let abortHandler;

        if (callerSignal?.aborted) relayAbort();
        else callerSignal?.addEventListener('abort', relayAbort, { once: true });

        const requestInit = { ...(init || {}), signal: controller.signal };
        if (attempt > 1) requestInit.cache = 'reload';

        const fetchPromise = Promise.resolve().then(() => nativeFetch(input, requestInit));
        // A timed-out WebKit fetch may ignore AbortController and reject much later.
        // Observe its eventual rejection so it never becomes an unhandled promise.
        fetchPromise.catch(() => {});

        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                state.timeouts++;
                state.lastTimeouts.push({ name, attempt, at: Date.now() });
                if (state.lastTimeouts.length > 8) state.lastTimeouts.splice(0, state.lastTimeouts.length - 8);
                controller.abort();
                publish();
                reject(new Error(`iPhone standalone resource timeout after ${timeoutMs} ms: ${name}`));
            }, timeoutMs);
        });

        const callerAbortPromise = callerSignal ? new Promise((_, reject) => {
            abortHandler = () => reject(abortError(callerSignal));
            if (callerSignal.aborted) abortHandler();
            else callerSignal.addEventListener('abort', abortHandler, { once: true });
        }) : new Promise(() => {});

        pending.set(requestId, { name, attempt, startedAt: Date.now() });
        publish();
        try {
            return await Promise.race([fetchPromise, timeoutPromise, callerAbortPromise]);
        } finally {
            clearTimeout(timeoutHandle);
            callerSignal?.removeEventListener?.('abort', relayAbort);
            callerSignal?.removeEventListener?.('abort', abortHandler);
            pending.delete(requestId);
            publish();
        }
    };

    globalThis.fetch = async (input, init = undefined) => {
        if (!shouldProtect(input)) return nativeFetch(input, init);

        await acquire();
        const name = resourceName(input);
        try {
            let lastError;
            for (let attempt = 1; attempt <= 2; attempt++) {
                const requestId = nextRequestId++;
                try {
                    return await fetchWithHardDeadline(input, init, attempt, name, requestId);
                } catch (error) {
                    if (init?.signal?.aborted) throw error;
                    lastError = error;
                    if (attempt >= 2) throw error;
                    state.retries++;
                    publish();
                    await wait(retryDelayMs);
                }
            }
            throw lastError;
        } finally {
            release();
        }
    };
})();
