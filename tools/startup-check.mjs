import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = resolve(process.cwd());
const out = resolve(process.env.STARTUP_REPORT_DIR || 'startup-report');
await mkdir(out, { recursive: true });
const { chromium, webkit, devices } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.gz': 'application/gzip' };
const server = createServer(async (req, res) => {
    try {
        const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = resolve(root, '.' + (path.endsWith('/') ? path + 'index.html' : path));
        if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
        const info = await stat(file);
        if (!info.isFile()) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'public, max-age=600' });
        createReadStream(file).pipe(res);
    } catch { res.writeHead(404).end('Not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const localUrl = `http://127.0.0.1:${server.address().port}/`;
let failed = false;
const measurements = [];
try {
    const runtime = await readFile(resolve(root, '_framework/dotnet.js'), 'utf8');
    const match = runtime.match(/\/\*json-start\*\/([\s\S]*?)\/\*json-end\*\//);
    if (!match) throw new Error('Published runtime config not found');
    const config = JSON.parse(match[1]);
    const assets = [];
    for (const [kind, entries] of Object.entries(config.resources)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            if (!entry.name) continue;
            const file = resolve(root, '_framework', entry.name);
            const bytes = await readFile(file);
            const digest = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
            if (entry.hash && entry.hash !== digest) throw new Error(`Integrity mismatch: ${entry.name}`);
            let gzipBytes = null;
            try { gzipBytes = (await stat(file + '.gz')).size; } catch { }
            assets.push({ kind, name: entry.name, bytes: bytes.length, gzipBytes });
        }
    }
    assets.sort((a, b) => b.bytes - a.bytes);
    const assetResult = { runtimeHash: config.resources.hash, count: assets.length, totalBytes: assets.reduce((s, a) => s + a.bytes, 0), totalGzipBytes: assets.reduce((s, a) => s + (a.gzipBytes ?? a.bytes), 0), assets };
    await writeFile(resolve(out, 'assets.json'), JSON.stringify(assetResult, null, 2));
    console.log('ASSETS', JSON.stringify({ ...assetResult, assets: assets.slice(0, 7) }));

    for (const [name, engine, mobile] of [['chromium', chromium, false], ['webkit-mobile-emulation', webkit, true]]) {
        const browser = await engine.launch({ headless: true });
        try {
            for (const [target, url] of [['local', localUrl], ['pages', 'https://yang-00712.github.io/StrForge/']]) {
                const context = await browser.newContext(mobile ? { ...devices['iPhone 14'] } : { viewport: { width: 1280, height: 900 } });
                await context.tracing.start({ screenshots: true, snapshots: true });
                const page = await context.newPage();
                const errors = [], badResponses = [], failedRequests = [];
                page.on('pageerror', e => errors.push(String(e)));
                page.on('requestfailed', r => failedRequests.push({ url: r.url(), error: r.failure()?.errorText }));
                page.on('response', r => { if (r.status() >= 400) badResponses.push({ url: r.url(), status: r.status() }); });
                await page.addInitScript(() => { performance.setResourceTimingBufferSize(1000); });
                for (const mode of ['cold', 'warm']) {
                    const started = Date.now();
                    const result = { browser: name, target, mode, errors, badResponses, failedRequests };
                    try {
                        const response = mode === 'cold' ? await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }) : await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
                        result.documentStatus = response?.status();
                        await page.waitForFunction(() => !document.querySelector('.loading') && [...document.querySelectorAll('canvas')].some(c => c.width > 0 && c.height > 0), { }, { timeout: 90000 });
                        result.readyMs = Date.now() - started;
                        await page.waitForTimeout(1000);
                        result.resources = await page.evaluate(() => performance.getEntriesByType('resource').map(e => ({ name: e.name, startTime: e.startTime, duration: e.duration, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize })));
                        result.totalTransferBytes = result.resources.reduce((s, e) => s + e.transferSize, 0);
                        result.totalDecodedBytes = result.resources.reduce((s, e) => s + e.decodedBodySize, 0);
                        result.storage = await page.evaluate(() => ({ primary: localStorage.getItem('strforge.state.v2'), backup: localStorage.getItem('strforge.state.v2.backup') }));
                        result.canvasCount = await page.locator('canvas').count();
                    } catch (e) { result.error = String(e); failed = true; }
                    await page.screenshot({ path: resolve(out, `${name}-${target}-${mode}.png`) }).catch(() => {});
                    result.elapsedMs = Date.now() - started;
                    measurements.push(structuredClone(result));
                    console.log('STARTUP', JSON.stringify({ ...result, resources: result.resources?.sort((a, b) => b.duration - a.duration).slice(0, 6), storage: result.storage ? 'recorded in artifact (test profile only)' : null }));
                }
                await context.tracing.stop({ path: resolve(out, `${name}-${target}-trace.zip`) });
                await context.close();
            }
        } finally { await browser.close(); }
    }
} finally {
    await writeFile(resolve(out, 'results.json'), JSON.stringify(measurements, null, 2));
    server.close();
}
if (failed) process.exitCode = 1;
