import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../index.js';
import type { CommandArgs, NucktyEnv } from '@nuckty/core';

function validateHandler(): (args: CommandArgs) => Promise<number> {
    let handler: ((args: CommandArgs) => Promise<number>) | undefined;
    const env = {
        commands: {
            add(_name: string, _description: string, command: (args: CommandArgs) => Promise<number>): void {
                handler = command;
            },
        },
    } as unknown as NucktyEnv;
    register(env);
    assert.ok(handler);
    return handler;
}

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
    const original = process.stderr.write;
    let output = '';
    process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof original;
    try {
        return { result: await run(), output };
    } finally {
        process.stderr.write = original;
    }
}

function args(overrides: Partial<CommandArgs> = {}): CommandArgs {
    return {
        positional: [],
        flags: {},
        config: { targets: {} } as CommandArgs['config'],
        cwd: '/path/that/must/not/be-read',
        ...overrides,
    };
}

test('validate: rejects --target before reading the target or starting validation', async () => {
    let cwdRead = false;
    const invalid = args({ flags: { target: 'second' } });
    Object.defineProperty(invalid, 'cwd', {
        get() {
            cwdRead = true;
            throw new Error('cwd was read');
        },
    });
    const handler = validateHandler();
    const { result, output } = await captureStderr(() => handler(invalid));

    assert.equal(result, 1);
    assert.match(output, /validate does not support --target/);
    assert.equal(cwdRead, false);
});

test('validate: rejects more than one target before reading the artifact', async () => {
    let cwdRead = false;
    const invalid = args({ positional: ['first', 'second'] });
    Object.defineProperty(invalid, 'cwd', {
        get() {
            cwdRead = true;
            throw new Error('cwd was read');
        },
    });
    const handler = validateHandler();
    const { result, output } = await captureStderr(() => handler(invalid));

    assert.equal(result, 1);
    assert.match(output, /usage: validate \[target\]/);
    assert.equal(cwdRead, false);
});
test('validate rejects an empty option key before accessing a valid target artifact', async () => {
    let cwdRead = false;
    const invalid = args({ flags: { '': true }, config: { targets: { main: { configDir: 'config', outDir: 'site' } } } });

    Object.defineProperty(invalid, 'cwd', {
        get() {
            cwdRead = true;
            throw new Error('cwd was read');
        },
    });
    const { result, output } = await captureStderr(() => validateHandler()(invalid));

    assert.equal(result, 1);
    assert.match(output, /validate does not support --/);
    assert.equal(cwdRead, false);
});


for (const port of [true, '', '0', '65536', '1.5', 'wrong']) {
    test(`validate rejects invalid port ${String(port)} before starting Java`, async () => {
        const env = { commands: { add: (_name: string, _description: string, handler: (args: CommandArgs) => Promise<number>) => { run = handler; } } };
        let run!: (args: CommandArgs) => Promise<number>;
        register(env as unknown as NucktyEnv);
        const stderr = process.stderr.write;
        let message = '';
        process.stderr.write = ((chunk: string) => { message += chunk; return true; }) as typeof stderr;

        try {
            assert.equal(await run(args({ flags: { port } })), 1);
            assert.match(message, /--port must be an integer/);
        } finally {
            process.stderr.write = stderr;
        }
    });
}
