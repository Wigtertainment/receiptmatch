import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { NuExtractSettings } from '../../electron/nuextract-settings.js';
import { localOcrRequestSchema, type NuExtractSettingsStatus } from '../../src/shared/local-ocr-settings.js';

test('resets previous model preferences without treating old downloaded files as NuExtract3', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(os.tmpdir(), 'receiptmatch-nuextract-upgrade-'));
    const settings: NuExtractSettings = new NuExtractSettings(root, path.join(root, 'missing-runtime'), path.join(root, 'probe.png'));
    try {
        for (const model of ['pp-ocrv6-medium', 'paddleocr-vl-1.6']) {
            const directory: string = path.join(root, model);
            const weights: string = path.join(directory, 'cached-model');
            await mkdir(directory);
            await writeFile(weights, 'legacy cache');
            await writeFile(path.join(root, 'selection.json'), JSON.stringify(model));
            await settings.resetLegacySelection();
            assert.equal(await readFile(path.join(root, 'selection.json'), 'utf8'), JSON.stringify('standard'));
            assert.equal(await readFile(weights, 'utf8'), 'legacy cache');
        }
        const status: NuExtractSettingsStatus = await settings.status();
        assert.equal(status.installed, false);
        assert.equal(status.device, 'cpu');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('keeps a new profile free of old settings and rejects retired model commands', async (): Promise<void> => {
    const root: string = await mkdtemp(path.join(os.tmpdir(), 'receiptmatch-nuextract-new-'));
    try {
        const settings: NuExtractSettings = new NuExtractSettings(root, path.join(root, 'missing-runtime'), path.join(root, 'probe.png'));
        await settings.resetLegacySelection();
        await assert.rejects(stat(path.join(root, 'selection.json')), { code: 'ENOENT' });
        assert.equal(localOcrRequestSchema.safeParse({ type: 'install', model: 'pp-ocrv6-medium' }).success, false);
        assert.equal(localOcrRequestSchema.safeParse({ type: 'select', selection: 'paddleocr-vl-1.6' }).success, false);
        assert.equal(localOcrRequestSchema.safeParse({ type: 'install-nuextract' }).success, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
