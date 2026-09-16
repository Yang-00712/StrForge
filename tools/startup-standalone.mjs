import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.cwd());
const { webkit, devices } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon'
};

const server = createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
        if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
        const info = await stat(file);
        if (!info.isFile()) { res.writeHead(404).end(); return; }
        res.writeHead(200, {
            'Content-Type': mime[extname(file)] || 'application/octet-stream',
            'Content-Length': info.size,
            'Cache-Control': 'public, max-age=600'
        });
        createReadStream(file).pipe(res);
    } catch {
        res.writeHead(404).end('Not found');
    }
});

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await webkit.launch({ headless: true });

async function createStandaloneContext({ simulateHungFetches = false } = {}) {
    const context = await browser.newContext({ ...devices['iPhone 14'], locale: 'zh-TW' });
    await context.addInitScript(({ simulateHungFetches }) => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
        globalThis.strforgeStandaloneFetchConfig = {
            maxParallel: 6,
            timeoutMs: simulateHungFetches ? 350 : 20000,
            retryDelayMs: simulateHungFetches ? 10 : 150
        };
        if (!simulateHungFetches) return;

        const realFetch = globalThis.fetch.bind(globalThis);
        const hung = new Set();
        globalThis.__strforgeInjectedHangs = [];
        globalThis.fetch = (input, init) => {
            try {
                const raw = input instanceof Request ? input.url : String(input);
                const requestUrl = new URL(raw, location.href);
                if (requestUrl.pathname.includes('/_framework/') && /\.wasm$/i.test(requestUrl.pathname)) {
                    const key = requestUrl.pathname;
                    if (!hung.has(key) && hung.size < 2) {
                        hung.add(key);
                        globalThis.__strforgeInjectedHangs.push(key.split('/').pop());
                        // Deliberately ignore AbortController to reproduce the exact
                        // class of WebKit failure seen on the real Home Screen app.
                        return new Promise(() => {});
                    }
                }
            } catch { }
            return realFetch(input, init);
        };
    }, { simulateHungFetches });
    return context;
}

async function waitForReady(page, timeout = 90000) {
    await page.waitForFunction(() =>
        !document.querySelector('.loading') &&
        [...document.querySelectorAll('canvas')].some(canvas => canvas.width > 0 && canvas.height > 0),
        {}, { timeout });
}

try {
    const context = await createStandaloneContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));

    for (const mode of ['cold', 'warm']) {
        const started = Date.now();
        if (mode === 'cold') {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } else {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
        }
        await waitForReady(page);

        const diagnostics = await page.evaluate(() => ({
            startup: globalThis.strforgeStartup,
            guard: globalThis.strforgeStandaloneFetch
        }));
        assert.equal(diagnostics.guard?.enabled, true);
        assert.equal(diagnostics.guard?.maxParallel, 6);
        assert.equal(diagnostics.startup?.status, 'ready');
        assert.equal(errors.length, 0);
        console.log('IOS_STANDALONE', JSON.stringify({
            mode,
            readyMs: diagnostics.startup.readyMs,
            guard: diagnostics.guard,
            elapsedMs: Date.now() - started
        }));
    }
    await context.close();

    // Regression for the real-device failure: two resource fetch promises never
    // resolve or reject, even when their AbortSignal is aborted. The guard must
    // stop waiting by its own deadline and retry instead of freezing at 41/43.
    const hungContext = await createStandaloneContext({ simulateHungFetches: true });
    const hungPage = await hungContext.newPage();
    const hungErrors = [];
    hungPage.on('pageerror', error => hungErrors.push(String(error)));
    const started = Date.now();
    await hungPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForReady(hungPage, 90000);
    const recovered = await hungPage.evaluate(() => ({
        startup: globalThis.strforgeStartup,
        guard: globalThis.strforgeStandaloneFetch,
        injectedHangs: globalThis.__strforgeInjectedHangs
    }));
    assert.equal(recovered.startup?.status, 'ready');
    assert.equal(recovered.guard?.enabled, true);
    assert.equal(recovered.injectedHangs?.length, 2);
    assert.ok(recovered.guard?.timeouts >= 2, `expected >=2 hard timeouts, got ${recovered.guard?.timeouts}`);
    assert.ok(recovered.guard?.retries >= 2, `expected >=2 retries, got ${recovered.guard?.retries}`);
    assert.equal(hungErrors.length, 0);
    console.log('IOS_STANDALONE_HUNG_FETCH_RECOVERY', JSON.stringify({
        readyMs: recovered.startup.readyMs,
        guard: recovered.guard,
        injectedHangs: recovered.injectedHangs,
        elapsedMs: Date.now() - started
    }));
    await hungContext.close();
} finally {
    await browser.close();
    server.close();
}
