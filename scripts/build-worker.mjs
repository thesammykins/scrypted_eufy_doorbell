// Bundles worker/main.ts (everything except eufy-sdk, which the plugin installs on the server with the
// worker's own Node 24 npm) and embeds it into the plugin as src/generated/worker.json.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const dependencies = pkg.eufyWorker.dependencies;

const result = await build({
    entryPoints: ['worker/main.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: Object.keys(dependencies),
    write: false,
    logLevel: 'warning',
});
const source = result.outputFiles[0].text;
const hash = createHash('sha256').update(source).update(JSON.stringify(dependencies)).digest('hex').slice(0, 16);

mkdirSync('src/generated', { recursive: true });
writeFileSync('src/generated/worker.json', JSON.stringify({ hash, dependencies, source }));
console.log(`worker bundle ${hash}: ${source.length} bytes, deps ${JSON.stringify(dependencies)}`);
