// Pinned official Pyodide distribution; application inputs stay inside this worker.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.6/full/pyodide.mjs";

const ready = (async () => {
    const runtime = await loadPyodide({indexURL: "https://cdn.jsdelivr.net/pyodide/v314.0.6/full/"});
    const response = await fetch(new URL("../python/calculator.py", import.meta.url));
    if (!response.ok) throw new Error("找不到 Python 計算檔。");
    runtime.runPython(await response.text());
    return {runtime, process: runtime.globals.get("process_json")};
})();

self.onmessage = async event => {
    const {id, json} = event.data;
    try {
        const engine = await ready;
        self.postMessage({id, json: engine.process(json)});
    } catch (error) {
        self.postMessage({id, error: String(error)});
    }
};
