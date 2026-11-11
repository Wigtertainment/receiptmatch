# ReceiptMatch

Local-first desktop application for matching individual bank transactions with supporting documents. Financial data stays local and original documents remain unchanged.

Create or open a local workspace, import a supported English Revolut Business EUR statement or Airwallex EUR Account Activity PDF, and analyse supporting documents. Review the results and explicitly save your work. Matching and document export are subsequent work.

## Build and run

Use Node.js 24.15 or newer within the supported Node 24 release line and npm.

```sh
npm ci
npm start
```

`npm start` prepares Electron and the local PDF/OCR resources, then runs the Angular development server with HMR and Electron together. Closing Electron also stops the development server. UI templates and styles update while the app is running; restart the command after changing Electron code. The development server listens only on `127.0.0.1:4310`; an occupied port stops startup instead of loading another application.

The Angular UI uses `angular.json`. Electron, preloads and the isolated extraction renderer use standard targets in `webpack.config.cjs`, TypeScript compilation through `ts-loader` and Webpack's built-in `output.copy` for offline assets. Add code entry points under `entry` and resource mappings under `output.copy`. Runtime packaging is configured in `electron-builder.yml`; startup and readiness use the standard `concurrently`, `cross-env` and `wait-on` commands.

Development enables CSS source maps. JavaScript source maps are disabled because Angular 22.2.6 changes their debug identifier during the first rebuild, causing a full reload instead of CSS HMR.

To build and start the compiled application without a development server or distribution package:

```sh
npm run start:dist
```

`npm run build` compiles the application without starting it. Packaging builds the application and uses the central `electron-builder.yml` configuration:

```sh
npm run pack:win
npm run pack:linux
```

Run each packaging command on its target operating system. Windows x64 output is `release/win-unpacked/ReceiptMatch.exe`; Linux x64 output is `release/linux-unpacked/receiptmatch`. These commands produce application directories; installers, signing and publishing are separate work. Only compiled application files, local PDF/OCR resources, licenses and production dependencies are packaged. SQLite uses the library's bundled Node-API prebuilds.

Workspaces use the `.receiptmatch` extension. New workspaces and imports remain in memory until saved. Existing unrelated files are never overwritten.

Choose **Import statement** in a workspace to select a PDF. Processing uses embedded text or bundled local English OCR and can be cancelled. Identical file contents are skipped. Both banks can share a workspace; select a statement to inspect its transactions and evidence. Review warnings and unresolved rows before using the data; dates and exact monetary values follow the system display locale. Original PDFs stay in place. Additional bank layouts and correction actions are subsequent work.

Under **Supporting documents**, choose a folder to analyse PDFs, PNGs and JPEGs in it and its subfolders. Review file results, extracted fields, alternative readings and source text with page locations. Cancelling keeps completed results. Save the workspace to keep the analysis and reopen it later.

## Checks

```sh
npm run check
npm run test:unit
npm run test:development
npm run test:electron
npm run test:packaged
npm run test:extraction
npm run test:import
npm run test:documents
npm run test:ui-import
```

`npm run check` runs ESLint with zero tolerated warnings and checks HTML formatting. Use `npm run lint:fix` and `npm run format` to apply available fixes. Prettier uses tabs and a 180-character line width; generated outputs and dependencies are excluded.

`npm run test:development` builds and exercises direct Electron execution, SQLite/local OCR and live CSS replacement without a distribution package. It temporarily adds an isolated marker to `src/styles.css` and restores the original bytes afterward; avoid editing that file during this check.

`npm run test:unit` prepares its own compiled test modules. Run the packaging command for your platform before running checks against the desktop executable. `npm run test:electron` runs all packaged checks with Playwright Test. Use the individual commands above to run a single suite. Generated results and screenshots go under ignored `artifacts/`. Remove temporary `release/`, `.build/`, `.angular/` and test outputs after successful use.

Extraction checks exercise isolated PDF text and local English OCR using synthetic PDF, PNG and JPEG inputs and bundled resources, including image limits, orientation and failures.

Import checks exercise native file selection, duplicate skipping and explicit workspace persistence through the validated desktop API. UI import checks use the actual controls, inspect financial fields and evidence, and capture synthetic-data screenshots. Native dialog selections are supplied by automation.

Document import checks use the packaged app to cover recursive mixed folders, PDF/PNG/JPEG analysis, file results and evidence, keyboard operation, cancellation and saved results across process restart.

For the Ubuntu 24.04 x64 container check:

```sh
docker build -t receiptmatch-workspace:ubuntu24.04 .
docker run --rm --init --network none --cap-add SYS_ADMIN --shm-size=512m receiptmatch-workspace:ubuntu24.04
```

The container uses Xvfb and a non-root user. The namespace capability is needed by the test host; Electron's sandbox remains enabled. This checks a packaged application directory, not an installer or the full Ubuntu desktop release matrix.
