import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { openBaseline } from './startup-baseline.mjs';

const exec = promisify(execFile);
const digest = bytes => 'sha256-' + createHash('sha256').update(bytes).digest('base64');
async function fixture(t, change = () => {}) {
    const root = await mkdtemp(join(tmpdir(), 'strforge-baseline-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const files = new Map([
        ['index.html', 'OLD-INDEX'], ['main.js', 'OLD-MAIN'],
        ['_framework/old.native.wasm', 'OLD-NATIVE'],
        ['_framework/old.app.wasm', 'OLD-APP'],
        ['_framework/old.runtime.js', 'OLD-RUNTIME'],
        ['_framework/zh/old.resources.wasm', 'OLD-SATELLITE'],
        ['js/persistence.js', 'OLD-PERSISTENCE']
    ]);
    const asset = name => ({ name, hash: digest(files.get('_framework/' + name)) });
    const config = { resources: {
        hash: digest('OLD-CONFIG'), wasmNative: [asset('old.native.wasm')],
        assembly: [asset('old.app.wasm')], jsModuleRuntime: [asset('old.runtime.js')],
        satelliteResources: { zh: [asset('zh/old.resources.wasm')] }
    } };
    files.set('_framework/dotnet.js', '/*json-start*/' + JSON.stringify(config) + '/*json-end*/');
    change(files);
    for (const [path, bytes] of files) {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), bytes);
    }
    const git = async args => (await exec('git', ['-C', root, ...args], { timeout: 10000 })).stdout.trim();
    await git(['init', '--quiet']);
    await git(['add', '.']);
    await git(['-c', 'user.name=Fixture test', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic fixture']);
    return { root, commit: await git(['rev-parse', 'HEAD']) };
}

test('complete pinned snapshot validates all assets, including satellites', async t => {
    const f = await fixture(t);
    const baseline = await openBaseline(f.root, f.commit);
    assert.equal(baseline.assetCount, 4);
    assert.equal((await baseline.read('/index.html')).toString(), 'OLD-INDEX');
    assert.equal((await baseline.read('/_framework/old.native.wasm')).toString(), 'OLD-NATIVE');
    assert.equal((await baseline.read('/js/persistence.js')).toString(), 'OLD-PERSISTENCE');
});
test('missing fixture location fails explicitly', async () => {
    await assert.rejects(openBaseline(undefined), /STARTUP_BASELINE_ROOT/);
});
test('moving branch names are rejected as fixture revisions', async t => {
    const f = await fixture(t);
    await assert.rejects(openBaseline(f.root, 'main'), /exact commit/);
});
test('wrong checkout commit fails before browser startup', async t => {
    const f = await fixture(t);
    await assert.rejects(openBaseline(f.root, '0'.repeat(40)), /wrong commit/);
});
test('dirty fixture cannot silently use changed application files', async t => {
    const f = await fixture(t);
    await writeFile(join(f.root, 'main.js'), 'CANDIDATE-MAIN');
    await assert.rejects(openBaseline(f.root, f.commit), /must be clean/);
});
test('old manifest plus missing old WASM fails immediately, not by UI timeout', async t => {
    const f = await fixture(t, files => files.delete('_framework/old.native.wasm'));
    await assert.rejects(openBaseline(f.root, f.commit), /old.native.wasm; no candidate fallback/);
});
test('wrong-version WASM cannot satisfy an old manifest', async t => {
    const f = await fixture(t, files => files.set('_framework/old.app.wasm', 'CANDIDATE-APP'));
    await assert.rejects(openBaseline(f.root, f.commit), /integrity failed: old.app.wasm/);
});
test('baseline does not fall back to a candidate file at the same relative path', async t => {
    const f = await fixture(t);
    const baseline = await openBaseline(f.root, f.commit);
    const candidate = await mkdtemp(join(tmpdir(), 'strforge-candidate-test-'));
    t.after(() => rm(candidate, { recursive: true, force: true }));
    await writeFile(join(candidate, 'candidate-only.js'), 'NEW');
    assert.equal((await readFile(join(candidate, 'candidate-only.js'))).toString(), 'NEW');
    await assert.rejects(baseline.read('candidate-only.js'), /no candidate fallback/);
});
test('path traversal and Git internals are not served', async t => {
    const f = await fixture(t);
    const baseline = await openBaseline(f.root, f.commit);
    for (const path of ['../main.js', '/.git/config', '..\\main.js']) {
        await assert.rejects(baseline.read(path), /Invalid baseline path/);
    }
});
test('fixture checks do not modify its tracked files or dirty worktree', async t => {
    const f = await fixture(t);
    await openBaseline(f.root, f.commit);
    const { stdout } = await exec('git', ['-C', f.root, 'status', '--porcelain', '--untracked-files=all']);
    assert.equal(stdout, '');
});
