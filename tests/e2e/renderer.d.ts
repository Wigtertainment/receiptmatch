import type { WorkspaceBridge } from '../../src/shared/protocol.js';

declare global {
	interface Window {
		receiptmatch: WorkspaceBridge;
	}
}
