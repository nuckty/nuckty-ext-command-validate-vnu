import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VnuHttpValidator } from '../index.js';

test('a foreign server cannot report invalid HTML as valid', async () => {
    let requests = 0;
    let spawned = 0;
    const server = http.createServer((request, response) => {
        requests++;
        request.resume();
        response.end(JSON.stringify({ messages: [] }));
    });
    const root = await mkdtemp(path.join(tmpdir(), 'nuckty-vnu-port-'));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    assert.ok(address && typeof address !== 'string');
    const validator = new VnuHttpValidator({ port: address.port }, {
        resolveJar: async () => '/fixture.jar',
        spawn: () => { spawned++; throw new Error('must not spawn'); },
    });

    try {
        const file = path.join(root, 'invalid.html');

        await writeFile(file, '<img src=x><invalid>');
        await assert.rejects(validator.validate([file]), /port .* unavailable/);
        assert.equal(requests, 0);
        assert.equal(spawned, 0);
    } finally {
        await validator.stop();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(root, { recursive: true, force: true });
    }
});
