import type { IWorkspaceBridge } from '../../src/shared/protocol.js';

declare global {
	interface Window {
		receiptmatch: IWorkspaceBridge;
	}
}
