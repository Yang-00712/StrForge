import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { gzipSync, gunzipSync, brotliDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { readRuntimeVersion } from '../main.js';
import { openBaseline } from './startup-baseline.mjs';

const root = process.cwd();
const out = resolve('startup-report');
await mkdir(out, { recursive: true });
const { chromium, webkit, devices } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const candidateIndex = await readFile('index.html');
const candidateMain = await readFile('main.js');
const runtime = await readFile('_framework/dotnet.js');
const currentHash = readRuntimeVersion(runtime.toString());
// A full pinned checkout lives in runner temp, never in the website tree.
// Every old request is served from that snapshot; no candidate fallback exists.
const baseline = await openBaseline(process.env.STARTUP_BASELINE_ROOT);
assert.ok(baseline.root !== root && !baseline.root.startsWith(root + sep),
    'Historical fixture must be outside the candidate website tree.');
const previousHash = baseline.hash;
assert.notEqual(currentHash, previousHash);
console.log('BASELINE', JSON.stringify({ commit: baseline.commit, hash: previousHash, assets: baseline.assetCount }));
for (const path of ['index.html', 'main.js']) {
    const plain = await readFile(path);
    assert.deepEqual(gunzipSync(await readFile(path+'.gz')), plain, path+' gzip differs');
    assert.deepEqual(brotliDecompressSync(await readFile(path+'.br')), plain, path+' brotli differs');
}
let mode = 'normal';
const requests = [];
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.wasm':'application/wasm', '.webmanifest':'application/manifest+json', '.png':'image/png', '.ico':'image/x-icon' };
const server = createServer(async (req,res) => {
    let request;
    try {
        const url = new URL(req.url, 'http://localhost');
        const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        const file = resolve(root, '.'+path);
        if (!file.startsWith(root+sep)) {res.writeHead(403).end();return;}
        const requestMode = mode;
        request = { path, search:url.search, mode:requestMode, cache:req.headers['cache-control'] || null, status:null };
        requests.push(request);
        if ((requestMode === 'loader404' && path === '/_framework/dotnet.js') ||
            (requestMode === 'module404' && path === '/_framework/dotnet.js' && url.searchParams.has('strforgeBuild')) ||
            (requestMode === 'wasm404' && path.includes('/dotnet.native.') && path.endsWith('.wasm'))) {
            request.status=404;
            res.writeHead(404,{'Cache-Control':'no-store'}).end('Injected test failure');return;
        }
        if (requestMode === 'delayed-native' && path.includes('/dotnet.native.') && path.endsWith('.wasm')) {
            await new Promise(r=>setTimeout(r,20000));
            if (res.destroyed) return;
        }
        let data = requestMode === 'previous' ? await baseline.read(path)
            : path === '/index.html' ? candidateIndex : path === '/main.js' ? candidateMain : await readFile(file);
        const headers = { 'Content-Type':mime[extname(path)] || 'application/octet-stream', 'Cache-Control':'public, max-age=600' };
        if (/gzip/.test(req.headers['accept-encoding'] || '') && !/\.(gz|br|png|ico)$/.test(path)) {
            data = gzipSync(data);headers['Content-Encoding']='gzip';headers.Vary='Accept-Encoding';
        }
        headers['Content-Length'] = data.length;
        request.status=200;
        res.writeHead(200,headers).end(data);
    } catch(error) {
        if(request) {request.status=404;request.error=String(error);}
        res.writeHead(404,{'Cache-Control':'no-store'}).end('Not found');
    }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url = `http://127.0.0.1:${server.address().port}/`;
const state = JSON.stringify({ schemaVersion:2, selectedTopTabIndex:0, fixedPrefix:'F', fixedSuffix:'L', mainInputText:'STARTUP-CHECK', exportCart:['保留-STARTUP'], stepRows:[{first:'100',second:'105'}], stepBatches:[{id:'startup-check-batch',capturedAt:'2026-09-16T00:00:00Z',rows:Array.from({length:30},(_,i)=>({rowNumber:i+1,first:'100',second:'105',difference:'5'}))}] });
async function seed(page) {
    await page.goto(url, {waitUntil:'domcontentloaded'});
    await page.evaluate(value=>{
        localStorage.setItem('strforge.state.v2', value);
        localStorage.setItem('strforge.state.v2.backup', value);
        localStorage.setItem('unrelated-test-key','KEEP');
    }, state);
}
async function assertState(page, exact=false) {
    const values = await page.evaluate(()=>({primary:localStorage.getItem('strforge.state.v2'),backup:localStorage.getItem('strforge.state.v2.backup'),other:localStorage.getItem('unrelated-test-key')}));
    if (exact) {assert.equal(values.primary,state);assert.equal(values.backup,state);}
    const restored=JSON.parse(values.primary);
    assert.equal(restored.stepBatches[0].id,'startup-check-batch');
    assert.equal(restored.stepBatches[0].rows.length,30);
    assert.equal(restored.exportCart[0],'保留-STARTUP');
    assert.equal(values.other,'KEEP');
}
async function ready(page, candidate=true) {
    await page.waitForFunction(candidate
        ? ()=>globalThis.strforgeStartup?.status === 'ready' && [...document.querySelectorAll('canvas')].some(c=>c.width>0 && c.height>0)
        : ()=>!document.querySelector('.loading') && [...document.querySelectorAll('canvas')].some(c=>c.width>0 && c.height>0), {}, {timeout:90000});
}
const results=[];let failed=false;
try {
    for (const [name, engine, options] of [['chromium',chromium,{viewport:{width:1280,height:900}}],['webkit-zh-TW-emulation',webkit,{...devices['iPhone 14'],locale:'zh-TW'}]]) {
        const browser=await engine.launch();
        try {
            const scenarios=['previous-cache-upgrade','loader404','module404','wasm404','delayed-native'];
            if (name === 'chromium') scenarios.push('4Mbps-cold');
            for (const scenario of scenarios) {
                const result={browser:name,scenario,phase:'seed'};const started=Date.now();
                const firstRequest=requests.length;
                const context=await browser.newContext(options);const page=await context.newPage();
                const errors=[];page.on('pageerror',e=>errors.push(String(e)));
                try {
                    // Seed only the isolated test profile, while startup is deliberately failed.
                    mode='loader404';await seed(page);
                    await page.waitForSelector('.loading[data-state="error"]');
                    await assertState(page,true);
                    if (scenario === 'previous-cache-upgrade') {
                        result.phase='baseline-startup';
                        mode='previous';await page.reload({waitUntil:'domcontentloaded'});await ready(page,false);
                        assert.equal(await page.evaluate(()=>typeof globalThis.strforgeStartup),'undefined');
                        await assertState(page);
                        assert.equal(errors.length,0,'Historical baseline must start without page errors.');
                        assert.equal(requests.slice(firstRequest).filter(r=>r.mode==='previous' && r.status>=400).length,0,
                            'Historical baseline must have all requested assets.');
                        result.baselineReady=true;
                        result.phase='candidate-upgrade';
                        mode='normal';const startIndex=requests.length;
                        await page.reload({waitUntil:'domcontentloaded'});await ready(page);
                        assert.equal(await page.evaluate(()=>strforgeStartup.runtimeHash),currentHash);
                        // Fetch cache=no-cache may send Cache-Control: max-age=0 (Fetch Standard).
                        const revalidated=requests.slice(startIndex).filter(r=>r.path==='/_framework/dotnet.js' && r.search==='');
                        assert.ok(revalidated.some(r=>/(?:no-cache|max-age=0)/i.test(r.cache || '')));
                        result.revalidationHeaders=revalidated.map(r=>r.cache);
                        await assertState(page);
                        result.phase='candidate-reopen';
                        await page.close();const reopened=await context.newPage();
                        await reopened.goto(url);await ready(reopened);await assertState(reopened);
                        await reopened.screenshot({path:resolve(out,`${name}-${scenario}.png`)});
                        result.previousHash=previousHash;result.currentHash=currentHash;
                        result.reopen='passed';
                    } else if (['loader404','module404','wasm404'].includes(scenario)) {
                        result.phase='injected-failure';
                        mode=scenario;await page.goto(url+'?failure='+scenario,{waitUntil:'domcontentloaded'});
                        await page.waitForSelector('.loading[data-state="error"]',{timeout:30000});
                        await assertState(page,true);
                        assert.ok((await page.locator('#strforge-startup-error').innerText()).length>0);
                        await page.screenshot({path:resolve(out,`${name}-${scenario}.png`)});
                        result.phase='retry';
                        mode='normal';await page.locator('#strforge-startup-retry').click();await ready(page);
                        await assertState(page);
                        assert.equal(new URL(page.url()).searchParams.has('strforgeRetry'),false);
                        result.retry='passed';
                    } else {
                        result.phase='slow-startup';
                        mode = scenario === 'delayed-native' ? 'delayed-native' : 'normal';
                        if(scenario==='4Mbps-cold') {
                            const cdp=await context.newCDPSession(page);
                            await cdp.send('Network.enable');
                            await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
                            await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:500000,uploadThroughput:500000});
                        }
                        const startLoad=Date.now();await page.goto(url+'?slow',{waitUntil:'domcontentloaded'});
                        await page.waitForTimeout(16000);
                        assert.equal(await page.evaluate(()=>strforgeStartup.status),'loading');
                        assert.ok(await page.locator('#strforge-startup-retry').isVisible());
                        await assertState(page,true);
                        await page.screenshot({path:resolve(out,`${name}-${scenario}-progress.png`)});
                        await ready(page);await assertState(page);
                        result.readyMs=Date.now()-startLoad;
                        await page.screenshot({path:resolve(out,`${name}-${scenario}-ready.png`)});
                    }
                    result.status='passed';
                } catch(error) {
                    failed=true;result.status='failed';result.error=String(error);
                    result.failedRequests=requests.slice(firstRequest).filter(r=>r.status>=400);
                    if(!page.isClosed()) await page.screenshot({path:resolve(out,`${name}-${scenario}-failed.png`)}).catch(()=>{});
                } finally {
                    result.elapsedMs=Date.now()-started;result.pageErrors=errors;
                    results.push(result);console.log('RECOVERY',JSON.stringify(result));await context.close();
                }
            }
        } finally {await browser.close();}
    }
} finally {
    await writeFile(resolve(out,'recovery.json'),JSON.stringify(results,null,2));server.close();
}
if(failed) process.exitCode=1;
