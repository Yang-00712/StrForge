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

try {
    const context = await browser.newContext({ ...devices['iPhone 14'], locale: 'zh-TW' });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    });
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
        await page.waitForFunction(() =>
            !document.querySelector('.loading') &&
            [...document.querySelectorAll('canvas')].some(canvas => canvas.width > 0 && canvas.height > 0),
            {}, { timeout: 90000 });

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
} finally {
    await browser.close();
    server.close();
}
