# @nuckty/ext-command-validate-vnu

> **Validate built HTML with the W3C Nu Html Checker — the `validate` command.**

An optional command-extension for [nuckty](https://github.com/nuckty/nuckty). It runs every built `<outDir>/html/` page through the Nu Html Checker (vnu.jar), which checks minimal HTML using the standard's optional-tag omission rules.

It requires a JVM and is installed only when needed. Unit tests verify individual engine transformations; they do not validate arbitrary consumer template structures.

## What it adds

One CLI command, registered through `env.commands`:

```
nuckty validate [target]
```

It validates every HTML file of the artifact and reports zero errors when the minimal output is correct.

## How it works

The extension starts one JVM for the command and sends HTTP requests to vnu.jar, with at most eight concurrent requests. Its content cache exists only in that process; a new CLI run validates the files again. The daemon starts on the first validation and stops during command cleanup, including on failure.

Port `127.0.0.1:8888` must be free: an already occupied port fails before Java starts. The availability check does not eliminate a race with another process binding between the check and Java startup. Unit tests do not certify arbitrary consumer templates.

## Requirements

- `java` in `PATH` (JVM 17+). Startup and validation time depend on the JVM, hardware and file count.
- `vnu-jar` 26.8.20 is a pinned dependency of this extension; no separate consumer install is required.
- Optional — not installed in CI unless validation is part of the pipeline.

Install a maintained system JVM before installing the extension. The upstream `vnu-jar` postinstall downloads its own JRE when system Java is missing; this extension uses `java` on PATH. CI checks system Java before installing validator dependencies.

The core does not depend on vnu or a JVM.

## How to load

This example extends the quickstart with the standard `@nuckty/ext-block-root` document handler. Add the new extension to `ext` in the global `config/config-nuckty.ts`, retaining the other entries. If you use a custom document handler, keep its registration instead of `@nuckty/ext-block-root`.

```ts
import { defineNucktyConfig } from '@nuckty/core';

export default defineNucktyConfig({
    targets: { main: { configDir: 'config/', outDir: 'site/' } },
    ext: ['@nuckty/ext-block-root', '@nuckty/ext-command-validate-vnu'],
});
```

Then:

```bash
npx @nuckty/core build
npx @nuckty/core validate
```

## Contract

`register(env: NucktyEnv)` adds `nuckty validate` through `env.commands.add`. Without a name, it selects the first target and recursively checks `.html` files in `outDir/html`. An empty file set, validation errors, protocol errors, or daemon cleanup errors produce a nonzero exit code.

## Spec

The specification in `openspec/specs/ext-command-validate-vnu/spec.md` describes the validation command, a per-run HTTP daemon, parallel processing and an in-memory cache. The extension is installed separately and requires a JVM.

## License

MIT.

Native command integration tests require the runtime on PATH and run with `NUCKTY_VNU_NATIVE=1 npm test`. CI requires this mode; the native scenario is explicitly skipped otherwise.


Use `nuckty validate [target] --port 18888` when the default port is occupied. The port must be an integer from 1 through 65535; validation and cleanup use the selected port.
