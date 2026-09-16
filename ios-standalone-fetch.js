(() => {
    const state = globalThis.strforgeStandaloneFetch = {
        enabled: false,
        maxParallel: 6,
        active: 0,
        queued: 0,
        retries: 0,
        timeouts: 0
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
    let active = 0;

    const publish = () => {
        state.active = active;
        state.queued = queue.length;
    };

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

    globalThis.fetch = async (input, init = undefined) => {
        if (!shouldProtect(input)) return nativeFetch(input, init);

        await acquire();
        try {
            let lastError;
            for (let attempt = 1; attempt <= 2; attempt++) {
                const controller = new AbortController();
                const callerSignal = init?.signal;
                let timedOut = false;
                const relayAbort = () => controller.abort(callerSignal?.reason);

                if (callerSignal?.aborted) {
                    relayAbort();
                } else {
                    callerSignal?.addEventListener('abort', relayAbort, { once: true });
                }

                const timer = setTimeout(() => {
                    timedOut = true;
                    state.timeouts++;
                    controller.abort();
                }, 20000);

                try {
                    const requestInit = { ...(init || {}), signal: controller.signal };
                    if (attempt > 1) requestInit.cache = 'reload';
                    return await nativeFetch(input, requestInit);
                } catch (error) {
                    if (callerSignal?.aborted) throw error;
                    lastError = error;
                    if (attempt >= 2) throw error;
                    state.retries++;
                    await wait(150);
                } finally {
                    clearTimeout(timer);
                    callerSignal?.removeEventListener?.('abort', relayAbort);
                }
            }
            throw lastError;
        } finally {
            release();
        }
    };
})();
