import { PNG } from "image-size/types/png";
import { JPG } from "image-size/types/jpg";
import type { IImage } from "image-size/types/interface";
import { PDF_EXTRACTION_LIMITS } from "../../src/shared/pdf-extraction.js";

export const IMAGE_MIME_TYPES: { readonly png: "image/png"; readonly jpeg: "image/jpeg"; } = { png: "image/png", jpeg: "image/jpeg" } as const;
export class ImageInputError extends Error {
	constructor(
		readonly code: "invalid-input" | "image-format" | "image-invalid" | "pixel-limit",
		message: string,
	) {
		super(message);
	}
}
export function assertImageDimensions(width: number, height: number): void {
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		width > 20000 ||
		height > 20000 ||
		width * height > PDF_EXTRACTION_LIMITS.pixelsPerPage
	) {
		throw new ImageInputError("pixel-limit", "The image exceeds the local dimension or pixel limit.");
	}
}

// This bounds decoder allocation using metadata; successful header parsing does not prove a complete or decodable image.
export function imageInputDimensions(bytes: Uint8Array, format: "png" | "jpeg", byteLimit: number = PDF_EXTRACTION_LIMITS.bytes): { width: number; height: number } {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > byteLimit) {
		throw new ImageInputError("invalid-input", "Choose a nonempty image within the local extraction byte limit.");
	}
	if (format !== "png" && format !== "jpeg") {
		throw new ImageInputError("image-format", "Choose a PNG or JPEG image.");
	}
	const signature: number[] = format === "png" ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8];
	if (!signature.every((value: number, index: number): boolean => bytes[index] === value)) {
		throw new ImageInputError("image-format", "The image signature does not match its authorized format.");
	}
	let dimensions: { width: number; height: number };
	try {
		// Library DataViews must not reach beyond the authorized byte view into its backing buffer.
		const bounded: Uint8Array<ArrayBufferLike> = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes);
		const parser: IImage = format === "png" ? PNG : JPG;
		if (!parser.validate(bounded)) {
			throw new Error("Unsupported image header.");
		}
		let metadata: Uint8Array<ArrayBufferLike> = bounded;
		if (format === "jpeg" && bounded[2] === 0xff && [0xc0, 0xc1, 0xc2].includes(bounded[3])) {
			// image-size skips JPEG's first segment. A metadata-only empty COM makes an initial SOF visible to its parser.
			// The original byte limit, source hash and image decoder input remain based on the unchanged source bytes.
			metadata = new Uint8Array(bounded.length + 4);
			metadata.set([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x02]);
			metadata.set(bounded.subarray(2), 6);
		}
		dimensions = parser.calculate(metadata);
	} catch {
		throw new ImageInputError("image-invalid", "The image header could not provide trustworthy dimensions.");
	}
	assertImageDimensions(dimensions.width, dimensions.height);
	return { width: dimensions.width, height: dimensions.height };
}
