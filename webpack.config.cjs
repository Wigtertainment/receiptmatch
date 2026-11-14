const path = require('node:path');

const typescript = {
	test: /\.ts$/,
	exclude: /node_modules/,
	use: {
		loader: 'ts-loader',
		options: {
			configFile: 'tsconfig.electron.json',
			transpileOnly: true,
			compilerOptions: { noEmit: false, module: 'ESNext', moduleResolution: 'Bundler' }
		}
	}
};
const resolve = { extensions: ['.ts', '.js', '.mjs', '.json'], extensionAlias: { '.js': ['.js', '.ts'] } };

module.exports = [
	{
		name: 'main',
		mode: 'production',
		context: __dirname,
		target: 'electron-main',
		entry: { main: './electron/main.ts', 'extraction-host': './electron/extraction/host.ts' },
		output: {
			path: path.resolve(__dirname, '.build'), filename: '[name].cjs', library: { type: 'commonjs2' },
			copy: [{ from: 'electron/extraction/paddle-medium.py', filename: 'extraction/paddle-medium.py' }]
		},
		// Load the separately emitted extraction host through Node's shared CommonJS cache.
		module: { rules: [typescript], parser: { javascript: { createRequire: false } } },
		resolve,
		externals: { electron: 'commonjs electron', 'better-sqlite3': 'commonjs better-sqlite3', 'electron-updater': 'commonjs electron-updater' },
		node: { __dirname: false, __filename: false },
		devtool: false,
		optimization: { minimize: false, splitChunks: false, runtimeChunk: false }
	},
	{
		name: 'preload',
		mode: 'production',
		context: __dirname,
		target: 'electron-preload',
		entry: { preload: './electron/preload.ts', 'extraction-preload': './electron/extraction/preload.ts', 'preview-preload': './electron/preview/preload.ts' },
		output: { path: path.resolve(__dirname, '.build'), filename: '[name].cjs' },
		module: { rules: [typescript] },
		resolve,
		externals: { electron: 'commonjs electron' },
		node: { __dirname: false, __filename: false },
		devtool: false,
		optimization: { minimize: false, splitChunks: false, runtimeChunk: false }
	},
	{
		name: 'extraction-renderer',
		mode: 'production',
		context: __dirname,
		target: ['web', 'es2022'],
		entry: './electron/extraction/renderer.ts',
		output: {
			path: path.resolve(__dirname, '.build/extraction'),
			filename: 'renderer.js',
			copy: [
				{ from: 'electron/extraction/index.html', filename: 'index.html' },
				{ from: 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs', to: 'pdf', filename: 'pdf.worker.min.mjs', info: { minimized: true } },
				{ from: 'node_modules/pdfjs-dist/cmaps', to: 'pdf/cmaps' },
				{ from: 'node_modules/pdfjs-dist/standard_fonts', to: 'pdf/standard_fonts' },
				{ from: 'node_modules/pdfjs-dist/wasm', to: 'pdf/wasm', info: { minimized: true } },
				{ from: 'node_modules/tesseract.js/dist/worker.min.js', to: 'ocr', filename: 'worker.min.js', info: { minimized: true } },
				{ context: 'node_modules/tesseract.js-core', from: 'tesseract-core*.{js,wasm}', to: 'ocr/core', info: { minimized: true } },
				{ from: 'node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz', to: 'ocr', filename: 'eng.traineddata.gz' },
				{ from: 'node_modules/pdfjs-dist/LICENSE', to: 'notices', filename: 'pdfjs.txt' },
				{ from: 'node_modules/image-size/LICENSE', to: 'notices', filename: 'image-size.txt' },
				{ from: 'node_modules/tesseract.js/LICENSE.md', to: 'notices', filename: 'tesseract-js.txt' },
				{ from: 'node_modules/tesseract.js-core/LICENSE', to: 'notices', filename: 'tesseract-core.txt' },
				{ from: 'electron/extraction/english-data-notice.txt', to: 'notices', filename: 'english-data.txt' }
			]
		},
		module: { rules: [typescript] },
		resolve,
		devtool: false,
		// Offline OCR requires local workers, WASM and language data beyond web-download budgets.
		performance: { hints: false },
		optimization: { minimize: false, splitChunks: false, runtimeChunk: false }
	}
];
