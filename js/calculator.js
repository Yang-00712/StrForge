let worker;
let sequence = 0;
const pending = new Map();

function stop(error) {
    worker?.terminate();
    worker = undefined;
    for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
    }
    pending.clear();
}

export function calculate(json) {
    // The Python runtime is loaded only when there is an actual input to calculate.
    const request = JSON.parse(json);
    if (request.operation !== "random_t90" && Object.values(request.inputs).every(value => !value?.trim()))
        return Promise.resolve(JSON.stringify({id: request.id, values: {}, error: null}));
    if (!worker) {
        worker = new Worker(new URL("./python-worker.js", import.meta.url), {type: "module"});
        worker.onmessage = event => {
            const request = pending.get(event.data.id);
            if (!request) return;
            pending.delete(event.data.id);
            clearTimeout(request.timer);
            if (event.data.error) request.reject(new Error(event.data.error));
            else request.resolve(event.data.json);
        };
        worker.onerror = event => stop(new Error(event.message || "Python worker failed"));
    }
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => stop(new Error("Python 載入逾時，請確認網路後重試。")), 90000);
        pending.set(id, {resolve, reject, timer});
        worker.postMessage({id, json});
    });
}

export function release() { stop(new Error("Python 資源已釋放。")); }
