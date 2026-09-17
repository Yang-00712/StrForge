// Test fixture only. Never imported by the website or copied into its payload.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';

export const BASELINE_COMMIT = 'dbcb7f69bc3497eaa3224599dc81b7fc728df82b';
const exec = promisify(execFile);

export async function openBaseline(directory, expectedCommit = BASELINE_COMMIT) {
    assert.ok(typeof directory === 'string' && directory.trim(),
        'STARTUP_BASELINE_ROOT must point to an isolated, complete historical checkout.');
    assert.match(expectedCommit, /^[a-f0-9]{40}$/, 'Baseline must use an exact commit SHA.');
    const root = await realpath(directory);
    const git = async args => (await exec('git', ['-C', root, ...args], {
        timeout: 10000, maxBuffer: 4 * 1024 * 1024
    })).stdout.trim();
    assert.equal(await git(['rev-parse', 'HEAD']), expectedCommit, 'Baseline checkout has the wrong commit.');
    assert.equal(await git(['status', '--porcelain', '--untracked-files=all']), '',
        'Baseline checkout must be clean; do not mix candidate files into it.');

    async function read(path) {
        assert.ok(typeof path === 'string' && path.length > 0 && !path.includes('\\') &&
            !path.split('/').some(part => part === '..' || part === '.git'), 'Invalid baseline path.');
        const file = resolve(root, path.replace(/^\/+/, ''));
        assert.ok(file.startsWith(root + sep), 'Baseline path escapes its checkout.');
        try {
            const actual = await realpath(file);
            assert.ok(actual.startsWith(root + sep), 'Baseline symlink escapes its checkout.');
            return await readFile(actual);
        } catch (cause) {
            throw new Error(`Baseline ${expectedCommit} cannot read ${path}; no candidate fallback.`, { cause });
        }
    }

    // Validate the entire declared runtime payload before launching any browser.
    // Missing/mismatched fixtures must fail here, not after a 90-second UI wait.
    await read('index.html');
    await read('main.js');
    const runtime = (await read('_framework/dotnet.js')).toString();
    const match = runtime.match(/\/\*json-start\*\/([\s\S]*?)\/\*json-end\*\//);
    assert.ok(match, 'Baseline runtime resource manifest is missing.');
    const config = JSON.parse(match[1]);
    assert.match(config.resources?.hash || '', /^sha256-[A-Za-z0-9+/]{43}=$/,
        'Baseline resource identifier is invalid.');
    const assets = [];
    function visit(value) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') {
            if (typeof value.name === 'string' && typeof value.hash === 'string') assets.push(value);
            else Object.values(value).forEach(visit);
        }
    }
    visit(config.resources);
    assert.ok(assets.length > 0, 'Baseline manifest has no assets.');
    for (const asset of assets) {
        const bytes = await read('_framework/' + asset.name);
        const hash = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
        assert.equal(hash, asset.hash, `Baseline resource integrity failed: ${asset.name}`);
    }
    return { root, commit: expectedCommit, hash: config.resources.hash, assetCount: assets.length, read };
}
