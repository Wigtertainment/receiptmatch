import { test } from "vitest";
import assert from "node:assert/strict";
import { imageInputDimensions, assertImageDimensions, ImageInputError, IMAGE_MIME_TYPES } from "../../electron/extraction/image-input.js";
import { extractionJobSchema, PDF_EXTRACTION_LIMITS } from "../../src/shared/pdf-extraction.js";

// Header-only fixtures exercise preflight, not successful raster decoding.
function pngHeader(width: number, height: number): Uint8Array {
	const bytes = Buffer.alloc(33);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	bytes[24] = 8;
	bytes[25] = 2;
	return bytes;
}
function jpegHeader(width: number, height: number): Uint8Array {
	const bytes = Buffer.from([
		255,
		216,
		255,
		224,
		0,
		16,
		...Array<number>(14).fill(0),
		255,
		192,
		0,
		17,
		8,
		height >> 8,
		height & 255,
		width >> 8,
		width & 255,
		3,
		1,
		17,
		0,
		2,
		17,
		1,
		3,
		17,
		1,
		255,
		217,
	]);
	return bytes;
}
function fails(code: string, action: () => unknown) {
	assert.throws(action, (error: unknown) => error instanceof ImageInputError && error.code === code);
}

test("PNG and JPEG byte headers expose dimensions without changing their bytes or requiring file access", () => {
	for (const [format, bytes] of [
		["png", pngHeader(1200, 360)],
		["jpeg", jpegHeader(800, 600)],
	] as const) {
		const original = Uint8Array.from(bytes);
		assert.deepEqual(imageInputDimensions(bytes, format), format === "png" ? { width: 1200, height: 360 } : { width: 800, height: 600 });
		assert.deepEqual(Uint8Array.from(bytes), original);
	}
	assert.deepEqual(IMAGE_MIME_TYPES, { png: "image/png", jpeg: "image/jpeg" });
});

test("JPEG dimensions also work when the frame is the first segment after SOI", () => {
	const normal = jpegHeader(20, 30);
	const frameFirst = Buffer.concat([normal.subarray(0, 2), normal.subarray(20)]);
	const original = Buffer.from(frameFirst);
	assert.deepEqual(imageInputDimensions(frameFirst, "jpeg"), { width: 20, height: 30 });
	assert.deepEqual(frameFirst, original);
});

test("format mismatch and unsupported signatures are rejected before decoding", () => {
	fails("image-format", () => imageInputDimensions(pngHeader(10, 20), "jpeg"));
	fails("image-format", () => imageInputDimensions(jpegHeader(10, 20), "png"));
	fails("image-format", () => imageInputDimensions(new TextEncoder().encode('<svg width="10" height="20"/>'), "png"));
	const damagedSignature = pngHeader(10, 20);
	damagedSignature[0] = 0;
	fails("image-format", () => imageInputDimensions(damagedSignature, "png"));
});

test("truncated or malformed image metadata returns controlled errors", () => {
	for (const [format, bytes] of [
		["png", pngHeader(20, 30).subarray(0, 18)],
		["jpeg", Uint8Array.from([255, 216, 255, 224, 255, 255])],
	] as const) {
		fails("image-invalid", () => imageInputDimensions(bytes, format));
	}
	fails("invalid-input", () => imageInputDimensions(new Uint8Array(), "png"));
	fails("invalid-input", () => imageInputDimensions(new Uint8Array(PDF_EXTRACTION_LIMITS.bytes + 1), "png"));
});

test("oversized headers and invalid dimensions are refused before a raster allocation", () => {
	for (const bytes of [pngHeader(4001, 4000), pngHeader(20001, 1), pngHeader(0xffffffff, 0xffffffff), pngHeader(0, 100)]) {
		assert.throws(() => imageInputDimensions(bytes, "png"), ImageInputError);
	}
	fails("pixel-limit", () => imageInputDimensions(jpegHeader(5000, 5000), "jpeg"));
	assertImageDimensions(4000, 4000);
	for (const [width, height] of [
		[0, 1],
		[1, -1],
		[NaN, 2],
		[Infinity, 1],
		[1.5, 2],
		[4001, 4000],
		[20001, 1],
	]) {
		assert.throws(() => assertImageDimensions(width, height), ImageInputError);
	}
});

test("the extraction job authorizes only the explicit PDF, PNG and JPEG format tags", () => {
	const value = { jobId: "00000000-0000-4000-8000-000000000001", sourceId: "synthetic-image", sha256: "a".repeat(64), bytes: pngHeader(10, 20) };
	for (const format of ["pdf", "png", "jpeg"]) assert.equal(extractionJobSchema.safeParse({ ...value, format }).success, true);
	for (const format of ["jpg", "svg", "image/png", "", null, undefined]) assert.equal(extractionJobSchema.safeParse({ ...value, format }).success, false);
	assert.equal(extractionJobSchema.safeParse(value).success, false);
});
