export type ExtractionOperation = 'image' | 'extract';
export interface ExtractionPage { page: number; method: 'embedded-text' | 'local-ocr'; text: string; confidence?: number; }
export interface ExtractionImage { image: string; }
export interface ExtractionDocument { pages: ExtractionPage[]; nodeAvailable: boolean; crossOriginIsolated?: boolean; }
export type ExtractionValue = ExtractionImage | ExtractionDocument;
export type ExtractionResult<Value extends ExtractionValue = ExtractionValue> = Value & { processId: number };
export interface ExtractionOverrides { maxPages?: number; maxPixels?: number; missingLanguage?: boolean; cancelOnOcr?: boolean; crashOnOcr?: boolean; }
export type ExtractionJob = { id: number; operation: 'image' } | { id: number; operation: 'extract'; bytes: Uint8Array; maxPages: number; maxPixels: number; missingLanguage?: boolean };
