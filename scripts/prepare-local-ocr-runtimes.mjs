import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(repo, '.build');
const output = path.join(build, 'local-ocr-runtimes');
const pythonRelease = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261110';
const llamaRelease = 'https://github.com/ggml-org/llama.cpp/releases/download/b12283';
const win = process.platform === 'win32';

const artifacts = {
    win32: {
        python: {
            url: `${pythonRelease}/cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
            hash: '355ee61b8207b91574491b1c6dc9b0ebb4408fc56bfafe498f3ef439314b52dc'
        },
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
        python: {
            url: `${pythonRelease}/cpython-3.12.16%2B20261110-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
            hash: '6a9e62dad033790aef722dbd370e0ce76ce17b73627ba3ae679f537049350b39'
        },
        llama: {
            url: `${llamaRelease}/llama-b12283-bin-ubuntu-x64.tar.gz`,
            hash: '5f24a62b84a37c186efd1e3e1d77bfad3a1772d9aa35bfcc9e1572723d0c4faf'
        }
    }
};

async function download({ url, hash }, target) {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
    const digest = createHash('sha256');
    const verify = new Transform({
        transform(chunk, _encoding, done) {
            digest.update(chunk);
            done(null, chunk);
        }
    });
    await pipeline(response.body, verify, createWriteStream(target, { flags: 'wx' }));
    if (digest.digest('hex') !== hash) throw new Error(`The SHA-256 digest did not match for ${url}.`);
}

function run(command, args, env) {
    const result = spawnSync(command, args, { cwd: repo, env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? result.signal}).`);
}

async function prepare() {
    const selected = artifacts[process.platform];
    if (process.arch !== 'x64' || !selected || (process.argv[2] && process.argv[2] !== process.platform)) {
        throw new Error('Local OCR packages must be built on x64 Windows or Linux for the corresponding platform.');
    }
    const tar = win ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await mkdir(build, { recursive: true });
    const scratch = await mkdtemp(path.join(build, '.prepare-ocr-'));
    const staging = path.join(scratch, 'runtimes');
    const llamaSource = path.join(scratch, 'llama');
    const pythonArchive = path.join(scratch, 'python.tar.gz');
    const llamaArchive = path.join(scratch, win ? 'llama.zip' : 'llama.tar.gz');
    try {
        await mkdir(staging);
        await mkdir(llamaSource);
        console.log('Downloading and verifying the CPU OCR runtimes.');
        await download(selected.python, pythonArchive);
        await download(selected.llama, llamaArchive);
        run(tar, ['-xf', pythonArchive, '-C', staging]);
        run(tar, ['-xf', llamaArchive, '-C', llamaSource, ...(win ? [] : ['--strip-components=1'])]);

        const llama = path.join(staging, 'llama');
        await mkdir(llama);
        const llamaFiles = win
            ? /^(?:llama-mtmd-cli\.exe|llama(?:-common)?\.dll|mtmd\.dll|ggml(?:-base|-cpu-[\w-]+)?\.dll|libomp\.dll|LICENSE.*)$/
            : /^(?:llama-mtmd-cli|lib(?:llama(?:-common)?|mtmd|ggml(?:-base|-cpu-[\w-]+)?)\.so(?:\.[\d.]+)?|LICENSE.*)$/;
        // Copy the resolved files so the package works even when a packager does not preserve library symlinks.
        for (const file of await readdir(llamaSource)) {
            if (llamaFiles.test(file)) await copyFile(path.join(llamaSource, file), path.join(llama, file));
        }
        if (selected.llamaLicense) await download(selected.llamaLicense, path.join(llama, 'LICENSE'));
        run(path.join(llama, win ? 'llama-mtmd-cli.exe' : 'llama-mtmd-cli'), ['--version']);

        const python = path.join(staging, 'python', win ? 'python.exe' : 'bin/python3.12');
        const requirements = path.join(repo, 'scripts', 'local-ocr-python-requirements.txt');
        const prefix = win ? ['--prefix', path.toNamespacedPath(path.join(staging, 'python'))] : [];
        run(python, ['-I', '-B', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-input', '--no-cache-dir', '--no-compile',
            '--only-binary=:all:', '--no-warn-script-location', '--index-url', 'https://pypi.org/simple', ...prefix, '-r', requirements],
            { ...process.env, PIP_CONFIG_FILE: devNull });
        run(python, ['-I', '-B', '-m', 'pip', 'check']);
        run(python, ['-I', '-B', '-c', 'import cv2, onnxruntime, paddleocr; assert "CPUExecutionProvider" in onnxruntime.get_available_providers()'],
            { ...process.env, PADDLE_PDX_CACHE_HOME: scratch, PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True', HF_HUB_OFFLINE: '1' });
        await rm(output, { recursive: true, force: true, maxRetries: 3 });
        await rename(staging, output);
        console.log(`OCR runtimes staged at ${output}`);
    } finally {
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
}

await prepare();
