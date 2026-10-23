import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type ChildProcess, type spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VnuHttpValidator } from '../index.js';

for (const mode of ['missing-java', 'early-exit', 'foreign-json', 'malformed-message', 'timeout', 'valid', 'death', 'stop-start'] as const) {
    test(`VNU lifecycle: ${mode}`, async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-vnu-lifecycle-'));
        const file = path.join(dir, 'a.html');
        await writeFile(file, '<p>fixture');
        const child = new EventEmitter() as ChildProcess;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        let exited = false;
        let killed = 0;
        let spawned = 0;
        let signalHealthRequest!: () => void;
        const healthRequested = new Promise<void>((resolve) => { signalHealthRequest = resolve; });
        child.kill = () => {
            killed++;
            setTimeout(() => { exited = true; child.emit('exit', 0); }, 5);
            return true;
        };
        const fakeSpawn: typeof spawn = (() => {
            spawned++;
            if (mode === 'missing-java') {
                queueMicrotask(() => child.emit('error', new Error('spawn java ENOENT')));
            } else if (mode === 'early-exit') {
                queueMicrotask(() => child.emit('exit', 1));
            }
            return child;
        }) as typeof spawn;
        const fakeFetch: typeof fetch = async (_input, options) => {
            signalHealthRequest();
            if (['timeout', 'stop-start', 'missing-java', 'early-exit'].includes(mode)) {
                return new Promise<Response>((_, reject) => {
                    const signal = options?.signal;
                    if (signal?.aborted) { reject(signal.reason); return; }
                    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            }
            const response = mode === 'foreign-json' ? {} : mode === 'malformed-message' ? { messages: [{}] } : { messages: [] };
            return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
        };
        const validator = new VnuHttpValidator({}, {
            checkPort: async () => {}, spawn: fakeSpawn, fetch: fakeFetch, resolveJar: async () => '/owned/fixture.jar',
            requestTimeoutMs: 10, startupTimeoutMs: 25, stopTimeoutMs: 100,
        });
        try {
            const validation = validator.validate([file], { noCache: true });
            if (mode === 'stop-start') {
                const checked = assert.rejects(validation, /stopped/);
                await healthRequested;
                await validator.stop();
                await checked;
                assert.equal(exited, true);
            } else if (mode === 'valid' || mode === 'death') {
                assert.deepEqual((await validation).passed, [file]);
                assert.equal(child.stdout.readableFlowing, true);
                assert.equal(child.stderr.readableFlowing, true);
                if (mode === 'death') {
                    child.emit('exit', 1);
                    await validator.validate([file], { noCache: true });
                    assert.equal(spawned, 2);
                }
                await validator.stop();
                assert.equal(exited, true);
                assert.equal(killed, 1);
            } else {
                await assert.rejects(validation, mode === 'missing-java' ? /ENOENT/ : mode === 'early-exit' ? /exited/ : mode === 'timeout' ? /ready/ : /protocol/);
            }
        } finally {
            await validator.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
}
