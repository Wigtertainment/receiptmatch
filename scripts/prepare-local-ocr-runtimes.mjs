import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(repo, '.build');
const output = path.join(build, 'local-ocr-runtimes');
const llamaRelease = 'https://github.com/ggml-org/llama.cpp/releases/download/b12283';
const win = process.platform === 'win32';

const artifacts = {
    win32: {
        llama: {
            url: `${llamaRelease}/llama-b12283-bin-win-cpu-x64.zip`,
            hash: 'dafb19ac757bfb7cfc1f91c6e26703264df861c4331e3ef6dc9543ae8d010c5e'
        },
        llamaLicense: {
            url: 'https://raw.githubusercontent.com/ggml-org/llama.cpp/b12283/LICENSE',
            hash: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
        }
    },
    linux: {
        llama: {
            url: `${llamaRelease}/llama-b12283-bin-ubuntu-x64.tar.gz`,
            hash: '5f24a62b84a37c186efd1e3e1d77bfad3a1772d9aa35bfcc9e1572723d0c4faf'
        }
    }
};

async function download({ url, hash }, target) {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) {
        throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
    }
    const digest = createHash('sha256');
    const verify = new Transform({
        transform(chunk, _encoding, done) {
            digest.update(chunk);
            done(null, chunk);
        }
    });
    await pipeline(response.body, verify, createWriteStream(target, { flags: 'wx' }));
    if (digest.digest('hex') !== hash) {
        throw new Error(`The SHA-256 digest did not match for ${url}.`);
    }
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit', windowsHide: true });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${path.basename(command)} failed (${result.status ?? result.signal}).`);
    }
}

async function prepare() {
    const selected = artifacts[process.platform];
    if (process.arch !== 'x64' || !selected || (process.argv[2] && process.argv[2] !== process.platform)) {
        throw new Error('Local AI packages must be built on x64 Windows or Linux for the corresponding platform.');
    }
    const tar = win ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await mkdir(build, { recursive: true });
    const scratch = await mkdtemp(path.join(build, '.prepare-ocr-'));
    const staging = path.join(scratch, 'runtimes');
    const llamaSource = path.join(scratch, 'llama');
    const llamaArchive = path.join(scratch, win ? 'llama.zip' : 'llama.tar.gz');
    try {
        await mkdir(staging);
        await mkdir(llamaSource);
        console.log('Downloading and verifying the NuExtract3 CPU runtime.');
        await download(selected.llama, llamaArchive);
        run(tar, ['-xf', llamaArchive, '-C', llamaSource, ...(win ? [] : ['--strip-components=1'])]);

        const llama = path.join(staging, 'llama');
        await mkdir(llama);
        const llamaFiles = win
            ? /^(?:llama-server\.exe|llama(?:-server-impl|-common)?\.dll|mtmd\.dll|ggml(?:-base|-cpu(?:-[\w-]+)?)?\.dll|libomp\.dll|LICENSE.*)$/
            : /^(?:llama-server|lib(?:llama(?:-server-impl|-common)?|mtmd|ggml(?:-base|-cpu(?:-[\w-]+)?)?)\.so(?:\.[\d.]+)?|LICENSE.*)$/;
        // Copy the resolved files so the package works even when a packager does not preserve library symlinks.
        for (const file of await readdir(llamaSource)) {
            if (llamaFiles.test(file)) {
                await copyFile(path.join(llamaSource, file), path.join(llama, file));
            }
        }
        if (selected.llamaLicense) {
            await download(selected.llamaLicense, path.join(llama, 'LICENSE'));
        }
        run(path.join(llama, win ? 'llama-server.exe' : 'llama-server'), ['--version']);

        await rm(path.join(build, 'extraction', 'paddle-medium.py'), { force: true });
        await rm(output, { recursive: true, force: true, maxRetries: 3 });
        await rename(staging, output);
        console.log(`NuExtract3 CPU runtime staged at ${output}`);
    } finally {
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
}

await prepare();
