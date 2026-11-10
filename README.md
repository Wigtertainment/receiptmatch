# ReceiptMatch

Local-first desktop application for matching individual bank transactions with supporting documents. Financial data stays local and original documents remain unchanged.

The current product foundation creates, opens, names, and explicitly saves local workspaces. Import, matching, and document export are subsequent work.

## Build and run

Use Node.js 24.15 or newer within the supported Node 24 release line and npm.

```sh
npm ci
npm run build
npm run package
npm start
```

Packages are written to `artifacts/package/ReceiptMatch-<platform>-<arch>/`. Workspaces use the `.receiptmatch` extension. New workspaces remain in memory until saved; existing unrelated files are never overwritten.

## Checks

```sh
npm run check
npm run test:unit
npm run test:packaged
npm run test:extraction
npm run test:import
```

`npm run check` runs ESLint with zero tolerated warnings and checks HTML formatting. Use `npm run lint:fix` and `npm run format` to apply available fixes. Prettier uses tabs and a 180-character line width; generated outputs and dependencies are excluded.

Packaged UI checks require the build and package above. They exercise the actual desktop executable; generated results and screenshots remain under ignored `artifacts/`.

Extraction checks exercise the isolated PDF text and local English OCR engine using synthetic PDFs and bundled resources. File import is not yet connected to the workspace UI.

Import checks exercise native file selection, duplicate skipping and explicit workspace persistence through the validated desktop API. Native dialog selections are supplied by automation; the transaction interface is subsequent work.

For the Ubuntu 24.04 x64 container check:

```sh
docker build -t receiptmatch-workspace:ubuntu24.04 .
docker run --rm --init --network none --cap-add SYS_ADMIN --shm-size=512m receiptmatch-workspace:ubuntu24.04
```

The container uses Xvfb and a non-root user. The namespace capability is needed by the test host; Electron's sandbox remains enabled. This checks a packaged application directory, not an installer or the full Ubuntu desktop release matrix.
