/**
 * Minimal ambient declaration for the `vnu-jar` package — it ships no types.
 *
 * `vnu-jar`'s main module exports the resolved path to the bundled `vnu.jar`
 * as its default export. The extension resolves the jar path via
 * `import('vnu-jar')` and reads `.default`.
 */

declare module 'vnu-jar' {
    /** Resolved filesystem path to the bundled `vnu.jar`. */
    const vnuJar: string;
    export default vnuJar;
}
