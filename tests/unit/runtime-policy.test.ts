import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isRendererRequestAllowed, resolveRendererUrl } from '../../electron/runtime-policy.js';

const production: "receiptmatch://app/index.html" = 'receiptmatch://app/index.html';
const development: "http://127.0.0.1:4310/" = 'http://127.0.0.1:4310/';
const invalidStartUrls: string[] = [
    '', ' ', 'http://127.0.0.1:4310', 'http://127.0.0.1:4310/index.html', 'http://127.0.0.1:4310/?dev=1', 'http://127.0.0.1:4310/#app',
    ' http://127.0.0.1:4310/', 'http://127.0.0.1:4310/\n', 'HTTP://127.0.0.1:4310/', 'https://127.0.0.1:4310/', 'ws://127.0.0.1:4310/',
    'http://localhost:4310/', 'http://[::1]:4310/', 'http://0.0.0.0:4310/', 'http://127.0.0.1:4311/', 'http://127.0.0.1:04310/',
    'http://127.0.0.1/', 'http://127.1:4310/', 'http://2130706433:4310/', 'http://0x7f000001:4310/', 'http://%31%32%37.0.0.1:4310/',
    'http://127.0.0.1.:4310/', 'http://user:password@127.0.0.1:4310/', 'http://127.0.0.1:4310@remote.invalid/', 'https://remote.invalid/',
    'receiptmatch://app/index.html', 'file:///index.html', 'javascript:alert(1)'
];

test('the unpackaged target defaults to local built assets and enables development only for the exact fixed start URL', (): void => {
    assert.equal(resolveRendererUrl(false), production);
    assert.equal(resolveRendererUrl(false, development), development);
    for (const value of invalidStartUrls) {
        assert.throws((): ReturnType<typeof resolveRendererUrl> => resolveRendererUrl(false, value), /ELECTRON_START_URL must be exactly http:\/\/127\.0\.0\.1:4310\//, value);
    }
});

test('packaged execution ignores the start environment variable and cannot enable development networking', (): void => {
    for (const value of [undefined, development, ...invalidStartUrls]) {
        const selected: ReturnType<typeof resolveRendererUrl> = resolveRendererUrl(true, value);
        assert.equal(selected, production);
        assert.equal(isRendererRequestAllowed(selected, development), false);
        assert.equal(isRendererRequestAllowed(selected, 'ws://127.0.0.1:4310/?token=hmr'), false);
    }
});

test('development allows canonical HTTP assets and WS hot reload on only the fixed loopback origin', (): void => {
    const selected: ReturnType<typeof resolveRendererUrl> = resolveRendererUrl(false, development);
    for (const value of [development, `${development}@vite/client`, `${development}main.js?v=123`, `${development}src/app.ts?ngcomp=component`, 'ws://127.0.0.1:4310/', 'ws://127.0.0.1:4310/?token=synthetic-hmr']) {
        assert.equal(isRendererRequestAllowed(selected, value), true, value);
    }
});

test('production allows only canonical local asset requests without credentials, query strings or fragments', (): void => {
    const selected: ReturnType<typeof resolveRendererUrl> = resolveRendererUrl(false);
    for (const value of [production, 'receiptmatch://app/main-ABC123.js', 'receiptmatch://app/assets/style.css']) {
        assert.equal(isRendererRequestAllowed(selected, value), true, value);
    }
    for (const value of [
        development, 'ws://127.0.0.1:4310/', 'receiptmatch://app.evil/index.html', 'receiptmatch://APP/index.html', 'receiptmatch://%61pp/index.html',
        'receiptmatch://user@app/index.html', 'receiptmatch://app:4310/index.html', 'receiptmatch://app/index.html?x=1', 'receiptmatch://app/index.html#x',
        'receiptmatch://app/index.html?', 'receiptmatch://app/index.html#',
        'receiptmatch://app/../index.html', 'receiptmatch://app/index.html\n', 'receiptmatch://other/index.html', 'file:///index.html', 'https://remote.invalid/'
    ]) {
        assert.equal(isRendererRequestAllowed(selected, value), false, value);
    }
});

test('development rejects host aliases, user information, protocol changes and parser normalization tricks', (): void => {
    const selected: ReturnType<typeof resolveRendererUrl> = resolveRendererUrl(false, development);
    for (const value of [
        ...invalidStartUrls, 'http://127.0.0.1:4310.evil/main.js', 'http://127.0.0.1.evil:4310/main.js', 'http://127.0.0.1:4310/../main.js',
        'http://127.0.0.1:4310/\\remote.invalid/main.js', 'wss://127.0.0.1:4310/', 'ws://localhost:4310/', 'ws://127.0.0.1:4311/',
        'ws://user@127.0.0.1:4310/', 'ws://%31%32%37.0.0.1:4310/', 'ws://127.0.0.1:4310/#fragment', 'ws://127.0.0.1:4310/#'
    ]) {
        // Path/query are forbidden for the environment value, but normal asset paths/query are needed by the development server.
        if ([`${development}index.html`, `${development}?dev=1`, 'ws://127.0.0.1:4310/'].includes(value)) {
            continue;
        }
        assert.equal(isRendererRequestAllowed(selected, value), false, value);
    }
});

test('an invalid runtime target cannot grant the production or development origins', (): void => {
    const invalid: ReturnType<typeof resolveRendererUrl> = 'http://remote.invalid/' as ReturnType<typeof resolveRendererUrl>;
    assert.equal(isRendererRequestAllowed(invalid, production), false);
    assert.equal(isRendererRequestAllowed(invalid, development), false);
});
