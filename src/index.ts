import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createServer } from 'node:net';
import type { NucktyEnv, CommandArgs } from '@nuckty/core';

export interface ValidationError {
    message: string;
    line?: number;
    column?: number;
    file?: string;
}

export interface ValidationResults {
    errors: ValidationError[];
    passed: string[];
    failed: string[];
    cached: number;
}

/** vnu.jar location: prefer the `vnu-jar` npm dependency if installed. */
async function resolveVnuJar(): Promise<string> {
    try {
        const vnuJarPkg = await import('vnu-jar');
        const pkg = vnuJarPkg as { default?: string };
        if (pkg.default) return pkg.default;
    } catch {
        // fall through
    }
    throw new Error(
        'vnu.jar not found. Install the `vnu-jar` npm package; Java must be available on PATH.',
    );
}

/**
 * vnu HTTP daemon validator: lazily spawns vnu.jar on `:8888`, health-checks,
 * reuses across validations, parallel POSTs, content-hash cache. `stop()` kills
 * the daemon — the extension manages its own lifecycle (no env.daemons).
 */
export class VnuHttpValidator {
    private readonly port: number;
    private readonly host: string;
    private proc: ChildProcess | null = null;
    private readonly cache: Map<string, ValidationError[]> = new Map();
    private starting: Promise<void> | null = null;
    private lifetime = new AbortController();
    private closed: Promise<void> = Promise.resolve();
    private readonly runtime;

    constructor(opts: { port?: number; host?: string } = {}, runtime: {
        spawn?: typeof spawn;
        fetch?: typeof fetch;
        resolveJar?: () => Promise<string>;
        checkPort?: (port: number, host: string) => Promise<void>;
        requestTimeoutMs?: number;
        startupTimeoutMs?: number;
        stopTimeoutMs?: number;
    } = {}) {
        this.runtime = runtime;
        this.port = opts.port ?? 8888;
        this.host = opts.host ?? '127.0.0.1';
    }

    async validate(files: string[], opts: { parallel?: boolean; noCache?: boolean } = {}): Promise<ValidationResults> {
        const parallel = opts.parallel ?? true;
        const useCache = !(opts.noCache ?? false);
        const tasks = files.map((f) => () => this.validateOne(f, useCache));
        const settled = parallel ? await runAll(tasks, 8) : await serial(tasks);
        const errors: ValidationError[] = [];
        const passed: string[] = [];
        const failed: string[] = [];
        let cached = 0;
        for (const [i, r] of settled.entries()) {
            const file = files[i]!;
            if (r.fromCache) cached++;
            if (r.errors.length === 0) passed.push(file);
            else {
                failed.push(file);
                for (const e of r.errors) errors.push({ ...e, file: e.file ?? file });
            }
        }
        return { errors, passed, failed, cached };
    }

    async stop(): Promise<void> {
        this.lifetime.abort(new Error('vnu stopped'));
        const proc = this.proc;
        if (proc) {
            proc.kill('SIGTERM');
            try {
                await this.waitForClose();
            } catch {
                proc.kill('SIGKILL');
                await this.waitForClose();
            }
        }
        if (this.starting) {
            await this.starting.catch(() => {});
        }
    }

    private async waitForClose(): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.closed,
                new Promise<void>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('vnu did not terminate')), this.runtime.stopTimeoutMs ?? 5_000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async validateOne(file: string, useCache: boolean): Promise<{ errors: ValidationError[]; fromCache: boolean }> {
        const html = await readFile(file, 'utf8');
        const key = createHash('sha256').update(html).digest('hex');
        if (useCache) {
            const hit = this.cache.get(key);
            if (hit) return { errors: hit, fromCache: true };
        }
        await this.ensureStarted();
        const errors = await this.postToVnu(html);
        if (useCache) this.cache.set(key, errors);
        return { errors, fromCache: false };
    }

    private async ensureStarted(): Promise<void> {
        // A start is in flight — await it (do NOT return early on `this.proc`
        // alone: spawn sets `this.proc` synchronously while `start()` is still
        // health-looping, so a concurrent caller would race past the readiness
        // gate and POST before the servlet is up).
        if (this.starting) return this.starting;
        if (this.proc && !this.proc.killed) return;
        this.starting = this.start();
        try {
            await this.starting;
        } finally {
            this.starting = null;
        }
    }

    private async start(): Promise<void> {
        this.lifetime = new AbortController();
        const lifetime = this.lifetime;
        const jar = await (this.runtime.resolveJar ?? resolveVnuJar)();
        lifetime.signal.throwIfAborted();
        await (this.runtime.checkPort ?? assertAvailablePort)(this.port, this.host);
        lifetime.signal.throwIfAborted();
        const proc = (this.runtime.spawn ?? spawn)('java', [
            '-Xss2048k',
            `-Dnu.validator.servlet.bind-address=${this.host}`,
            '-cp', jar, 'nu.validator.servlet.Main', String(this.port),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = proc;
        this.closed = new Promise<void>((resolve) => {
            proc.once('error', (error) => {
                lifetime.abort(error);
                if (!proc.pid) {
                    this.proc = null;
                    resolve();
                }
            });
            proc.once('exit', (code, signal) => {
                lifetime.abort(new Error(`vnu exited (${code ?? signal})`));
                if (this.proc === proc) {
                    this.proc = null;
                }
                resolve();
            });
        });
        proc.stdout?.resume();
        proc.stderr?.resume();
        const deadline = Date.now() + (this.runtime.startupTimeoutMs ?? 30_000);
        while (Date.now() < deadline) {
            lifetime.signal.throwIfAborted();
            try {
                await this.postToVnu('<!doctype html><html><body></body></html>');
                lifetime.signal.throwIfAborted();
                return;
            } catch (error) {
                lifetime.signal.throwIfAborted();
                if (error instanceof Error && /protocol|HTTP/.test(error.message)) {
                    throw error;
                }
            }
            await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
        }
        throw new Error(`vnu HTTP daemon did not become ready on ${this.host}:${this.port}`);
    }

    private async postToVnu(html: string): Promise<ValidationError[]> {
        const signal = AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(this.runtime.requestTimeoutMs ?? 5_000),
        ]);
        const res = await (this.runtime.fetch ?? fetch)(`http://${this.host}:${this.port}/?out=json&level=error`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: html,
            signal,
        });
        if (!res.ok) {
            throw new Error(`vnu HTTP ${res.status}`);
        }
        const data: unknown = await res.json();
        if (!data || typeof data !== 'object' || !('messages' in data) || !Array.isArray(data.messages)) {
            throw new Error('Invalid vnu protocol response: messages array required');
        }
        const errors: ValidationError[] = [];
        for (const message of data.messages) {
            if (!message || typeof message !== 'object' || typeof message.type !== 'string'
                || !['error', 'non-document-error', 'info'].includes(message.type)
                || typeof message.message !== 'string'
                || (message.lastLine !== undefined && !Number.isInteger(message.lastLine))
                || (message.firstColumn !== undefined && !Number.isInteger(message.firstColumn))) {
                throw new Error('Invalid vnu protocol message');
            }
            if (message.type === 'error' || message.type === 'non-document-error') {
                const error: ValidationError = { message: message.message };
                if (message.lastLine !== undefined) {
                    error.line = message.lastLine;
                }
                if (message.firstColumn !== undefined) {
                    error.column = message.firstColumn;
                }
                errors.push(error);
            }
        }
        return errors;
    }

}

/** Refuse a foreign service before any health or validation requests. */
async function assertAvailablePort(port: number, host: string): Promise<void> {
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
        server.once('error', (error) => reject(new Error(`vnu port ${host}:${port} is unavailable: ${error.message}`)));
        server.listen(port, host, () => {
            server.close((error) => error ? reject(error) : resolve());
        });
    });
}

let defaultValidator: VnuHttpValidator | null = null;
let defaultPort = 8888;
function getDefaultValidator(port: number): VnuHttpValidator {
    if (!defaultValidator || port !== defaultPort) {
        defaultPort = port;
        defaultValidator = new VnuHttpValidator({ port });
    }
    return defaultValidator;
}

/** Recursively collect every `.html` file under `dir` (spec: every HTML file). */
export async function findHtmlFiles(dir: string, base: string[]): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !base.includes(entry.name)) {
            files.push(...(await findHtmlFiles(full, base)));
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
            files.push(full);
        }
    }
    return files;
}

/** `nuckty validate [target]` — validate the chosen target's artifact with vnu. */
async function validate(args: CommandArgs): Promise<number> {
    if (args.positional.length > 1) {
        process.stderr.write('nuckty: usage: validate [target]\n');
        return 1;
    }
    const unsupportedFlag = Object.keys(args.flags).find((name) => name !== 'port');
    if (unsupportedFlag !== undefined) {
        process.stderr.write(`nuckty: validate does not support --${unsupportedFlag}\n`);
        return 1;
    }

    const value = args.flags['port'];
    const port = value === undefined ? 8888 : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        process.stderr.write('nuckty: --port must be an integer from 1 through 65535\n');
        return 1;
    }

    // CMD-14: resolve the target the same way build/serve do instead of
    // always reading `cwd/site/html`. A wrong target name must fail before
    // any validation, not silently check the default artifact; a custom
    // outDir is honored; nested HTML files are included per spec.
    let outDir: string;
    let targetName: string;
    try {
        const { resolveTarget } = await import('@nuckty/core');
        const target = resolveTarget(args.config, args.positional[0]);
        targetName = target.name;
        outDir = path.join(args.cwd, target.outDir);
    } catch (e) {
        process.stderr.write(`nuckty: ${(e as Error).message}\n`);
        return 1;
    }
    const htmlDir = path.join(outDir, 'html');
    let files: string[];
    try {
        files = await findHtmlFiles(htmlDir, []);
    } catch {
        process.stderr.write(`nuckty: no html directory found at ${htmlDir} (target "${targetName}"). Run \`nuckty build\` first.\n`);
        return 1;
    }
    if (files.length === 0) {
        process.stderr.write('nuckty: no HTML files to validate.\n');
        return 1;
    }
    const validator = getDefaultValidator(port);
    let results: ValidationResults;
    try {
        results = await validator.validate(files);
    } catch (e) {
        process.stderr.write(`nuckty: validation failed: ${(e as Error).message}\n`);
        return 1;
    } finally {
        try {
            await validator.stop();
        } catch (error) {
            process.stderr.write(`nuckty: validator cleanup failed: ${(error as Error).message}\n`);
            return 1;
        }
    }
    for (const err of results.errors) {
        const where = err.file ? `${err.file}:${err.line ?? ''}:${err.column ?? ''}` : '';
        process.stderr.write(`✖ ${where} ${err.message}\n`);
    }
    process.stdout.write(
        `nuckty: validate — ${results.passed.length} passed, ${results.failed.length} failed, ${results.cached} cached\n`,
    );
    return results.failed.length === 0 ? 0 : 1;
}

export function register(env: NucktyEnv): void {
    env.commands.add('validate', 'validate built HTML with vnu.jar', validate);
}

export default register;

export async function serial<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    const out: T[] = [];
    for (const t of tasks) out.push(await t());
    return out;
}

/** Run task factories with bounded concurrency; retain result order and
 *  settle active tasks before reporting the first failure. */
export async function runAll<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const out: T[] = new Array(tasks.length);
    let next = 0;
    let failed = false;
    let failure: unknown;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, async () => {
        while (!failed) {
            const i = next++;
            if (i >= tasks.length) break;
            try {
                out[i] = await tasks[i]!();
            } catch (error) {
                if (!failed) {
                    failure = error;
                    failed = true;
                }
            }
        }
    });
    await Promise.all(workers);
    if (failed) {
        throw failure;
    }
    return out;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
