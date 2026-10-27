import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { NucktyEnv, type CommandArgs } from '@nuckty/core';
import { register } from '../index.js';

function command() {
    const env = new NucktyEnv();
    register(env);
    return env.commands.get('validate')!.handler;
}

function args(cwd: string): CommandArgs {
    return {
        cwd,
        config: { targets: { first: { configDir: 'config', outDir: 'unused' }, chosen: { configDir: 'config', outDir: 'artifact' } } },
        positional: ['chosen'],
        flags: {},
    };
}

async function capture(run: () => Promise<number>) {
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    let output = '';
    const write = ((chunk: string) => { output += chunk; return true; }) as typeof stdout;
    process.stdout.write = write;
    process.stderr.write = write;
    try {
        return { status: await run(), output };
    } finally {
        process.stdout.write = stdout;
        process.stderr.write = stderr;
    }
}

for (const state of ['missing', 'empty'] as const) {
    test(`validate command rejects a ${state} selected artifact`, async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), 'nuckty-vnu-artifact-'));
        try {
            if (state === 'empty') {
                await mkdir(path.join(cwd, 'artifact/html'), { recursive: true });
            }
            const result = await capture(() => command()(args(cwd)));
            assert.equal(result.status, 1);
            assert.match(result.output, state === 'missing' ? /no html directory.*artifact\/html/ : /no HTML files/);
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });
}

test('native validate command checks nested HTML, rejects changed invalid content and stops Java', {
    skip: process.env.NUCKTY_VNU_NATIVE !== '1',
    timeout: 45_000,
}, async () => {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', resolve);
    });
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    assert.equal(spawnSync('java', ['-version']).status, 0, 'native validation requires Java on PATH');
    const cwd = await mkdtemp(path.join(tmpdir(), 'nuckty-vnu command – пример '));
    const selectedArgs = args(cwd);
    selectedArgs.flags = { port: String(port) };
    try {
        const directory = path.join(cwd, 'artifact/html/nested');
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, 'index.html');
        const valid = '<!doctype html><html lang=en><head><meta charset=utf-8><title>Fixture</title></head><body><p>Valid</p></body></html>';
        await writeFile(file, valid);
        const handler = command();
        const first = await capture(() => handler(selectedArgs));
        assert.equal(first.status, 0, first.output);
        assert.match(first.output, /1 passed, 0 failed, 0 cached/);
        const cached = await capture(() => handler(selectedArgs));
        assert.equal(cached.status, 0, cached.output);
        assert.match(cached.output, /1 passed, 0 failed, 1 cached/);
        await writeFile(file, valid.replace('<p>Valid</p>', '<img>'));
        const invalid = await capture(() => handler(selectedArgs));
        assert.equal(invalid.status, 1);
        assert.match(invalid.output, /0 passed, 1 failed, 0 cached/);
        assert.ok(invalid.output.includes(file));
        assert.match(invalid.output, /alt|src/);
        const probe = createServer();
        await new Promise<void>((resolve, reject) => {
            probe.once('error', reject);
            probe.listen(port, '127.0.0.1', resolve);
        });
        await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
