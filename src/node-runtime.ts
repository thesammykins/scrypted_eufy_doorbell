import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// eufy-sdk's floor. Scrypted's Docker image ships Node 22, so the worker gets its own runtime.
const MIN_NODE = [24, 5];
const NODE_VERSION = 'v24.22.3';
// From https://nodejs.org/dist/v24.22.3/SHASUMS256.txt — pinned so a tampered download is refused.
const NODE_SHA256: Record<string, string> = {
    'linux-x64': '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2',
    'linux-arm64': '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8',
    'darwin-arm64': 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
    'darwin-x64': '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
};

export interface NodeRuntime {
    node: string;
    npmCli: string;
    binDir: string;
}

function hostSatisfies() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** Returns a Node ≥ 24.5, downloading and verifying the pinned build into the plugin volume on first use. */
export async function ensureNodeRuntime(volume: string, console: Console): Promise<NodeRuntime> {
    if (hostSatisfies()) {
        const binDir = path.dirname(process.execPath);
        return { node: process.execPath, binDir, npmCli: path.join(binDir, '../lib/node_modules/npm/bin/npm-cli.js') };
    }

    const platform = `${process.platform}-${process.arch}`;
    const sha256 = NODE_SHA256[platform];
    if (!sha256)
        throw new Error(`no pinned Node ${NODE_VERSION} build for ${platform}`);

    const dirName = `node-${NODE_VERSION}-${platform}`;
    // Not at the volume root: Scrypted deletes top-level node-* folders there whenever the plugin updates.
    const runtimeDir = path.join(volume, 'eufy-runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const root = path.join(runtimeDir, dirName);
    const runtime: NodeRuntime = {
        node: path.join(root, 'bin/node'),
        binDir: path.join(root, 'bin'),
        npmCli: path.join(root, 'lib/node_modules/npm/bin/npm-cli.js'),
    };
    if (fs.existsSync(runtime.node) && fs.existsSync(runtime.npmCli))
        return runtime;

    const url = `https://nodejs.org/dist/${NODE_VERSION}/${dirName}.tar.gz`;
    console.log(`downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`Node download failed: HTTP ${response.status}`);
    const tarball = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(tarball).digest('hex');
    if (actual !== sha256)
        throw new Error(`Node download checksum mismatch (expected ${sha256}, got ${actual}); refusing to use it`);

    const tarPath = path.join(runtimeDir, `${dirName}.tar.gz`);
    fs.writeFileSync(tarPath, tarball);
    fs.rmSync(root, { recursive: true, force: true });
    await execFileAsync('tar', ['-xzf', tarPath, '-C', runtimeDir]);
    fs.rmSync(tarPath, { force: true });
    console.log(`installed Node ${NODE_VERSION} at ${root}`);
    return runtime;
}

export interface WorkerBundle {
    hash: string;
    dependencies: Record<string, string>;
    source: string;
}

/** Writes the embedded worker and installs its npm dependencies with the worker's own Node/npm. */
export async function installWorker(volume: string, runtime: NodeRuntime, bundle: WorkerBundle, console: Console): Promise<string> {
    const dir = path.join(volume, 'eufy-worker');
    const entry = path.join(dir, 'worker.mjs');
    const stamp = path.join(dir, '.installed');
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(entry) && readIf(stamp) === bundle.hash)
        return entry;

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: bundle.dependencies }, null, 2));
    console.log(`installing worker dependencies ${JSON.stringify(bundle.dependencies)}`);
    const env = { ...process.env, PATH: `${runtime.binDir}${path.delimiter}${process.env.PATH}` };
    const { stdout, stderr } = await execFileAsync(runtime.node, [runtime.npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 });
    if (stdout.trim())
        console.log(stdout.trim());
    if (stderr.trim())
        console.warn(stderr.trim());
    fs.writeFileSync(entry, bundle.source);
    fs.writeFileSync(stamp, bundle.hash);
    return entry;
}

function readIf(file: string) {
    try {
        return fs.readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
}
