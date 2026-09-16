import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readRuntimeVersion, runtimeUrl, withDeadline } from '../main.js';

const hash = 'sha256-wcsCYp8TiFUa+kS6sLAqOPY/Txc2AXz17awzHFZIesU=';
test('published config identifies content without changing app version', () => {
    assert.equal(readRuntimeVersion('prefix/*json-start*/' + JSON.stringify({resources:{hash}}) + '/*json-end*/suffix'), hash);
});
test('missing or malformed runtime config fails explicitly', () => {
    for (const text of ['', '<html>404</html>', '/*json-start*/{}/*json-end*/', '/*json-start*/oops/*json-end*/']) assert.throws(() => readRuntimeVersion(text));
});
test('malformed hash is rejected', () => {
    assert.throws(() => readRuntimeVersion('/*json-start*/{"resources":{"hash":"../../other"}}/*json-end*/'));
});
test('same runtime content keeps same URL for warm module cache', () => {
    const a = runtimeUrl('https://example.test/StrForge/', hash);
    assert.equal(a, runtimeUrl('https://example.test/StrForge/', hash));
    assert.equal(new URL(a).pathname, '/StrForge/_framework/dotnet.js');
    assert.equal(new URL(a).searchParams.get('strforgeBuild'), hash);
});
test('resource change changes runtime import without changing home-screen path', () => {
    const other = 'sha256-UcocjnbGFwbMIGryLYn34viQL3oUDRNK7dU1AXTdnCo=';
    assert.notEqual(runtimeUrl('https://example.test/StrForge/', hash), runtimeUrl('https://example.test/StrForge/', other));
});
test('successful operation cancels its timeout callback', async () => {
    let called = false;
    assert.equal(await withDeadline(Promise.resolve(42), 10, () => {called=true;}), 42);
    await new Promise(r=>setTimeout(r,20));
    assert.equal(called, false);
});
test('operation errors are preserved', async () => {
    const error = new Error('HTTP 404');
    await assert.rejects(withDeadline(Promise.reject(error), 100), e=>e===error);
});
test('hung operation times out exactly once', async () => {
    let count=0;
    await assert.rejects(withDeadline(new Promise(()=>{}), 10, ()=>{count++;}), /120/);
    assert.equal(count,1);
});
test('late failure after timeout does not launch another runtime', async () => {
    let reject;
    const operation = new Promise((_, r)=>{reject=r;});
    await assert.rejects(withDeadline(operation,10), /120/);
    reject(new Error('late failure'));
    await new Promise(r=>setTimeout(r,10));
});
test('bootstrap has no persistence writes, cache deletion or service-worker registration', async () => {
    const source = await readFile(new URL('../main.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage\s*\.|indexedDB\s*\.|caches\s*\.\s*delete|serviceWorker\s*\.\s*register/);
});
