import { describe, expect, it } from 'vitest';
import { InterpreterError } from '../src/errors';
import { inflateZstd, wasmModuleFromZstd, zstdContentSize } from '../src/inflate';

// a valid EMPTY wasm module (magic + version) and its zstd frame, produced with
// `zstd --ultra -22`. Embedded as bytes because fzstd only decompresses, so the suite
// cannot build a frame at runtime
const EMPTY_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const EMPTY_WASM_ZSTD = new Uint8Array([
	40, 181, 47, 253, 36, 8, 65, 0, 0, 0, 97, 115, 109, 1, 0, 0, 0, 186, 52, 157, 64
]);
// a well-formed zstd frame whose payload is text, so it inflates and then fails to compile
const TEXT_ZSTD = new Uint8Array([
	40, 181, 47, 253, 36, 34, 17, 1, 0, 110, 111, 116, 32, 97, 32, 122, 115, 116, 100, 32, 102, 114,
	97, 109, 101, 32, 97, 116, 32, 97, 108, 108, 44, 32, 106, 117, 115, 116, 32, 116, 101, 120, 116,
	43, 9, 145, 137
]);

describe('inflateZstd', () => {
	it('inflates a frame to the original bytes', () => {
		expect(inflateZstd(EMPTY_WASM_ZSTD)).toStrictEqual(EMPTY_WASM);
	});

	it('accepts an ArrayBuffer, which is what a Data module import gives', () => {
		const buffer = EMPTY_WASM_ZSTD.slice().buffer;
		expect(inflateZstd(buffer)).toStrictEqual(EMPTY_WASM);
	});

	it('fills a pre-sized buffer when told the inflated length', () => {
		expect(inflateZstd(EMPTY_WASM_ZSTD, { inflatedSize: EMPTY_WASM.byteLength })).toStrictEqual(
			EMPTY_WASM
		);
	});

	it('throws on an empty blob, which is what a missing Data rule looks like', () => {
		expect(() => inflateZstd(new Uint8Array(0))).toThrow(InterpreterError);
		expect(() => inflateZstd(new Uint8Array(0))).toThrow(/Data module rule/);
	});

	it('carries a stable code on an empty blob', () => {
		try {
			inflateZstd(new ArrayBuffer(0));
			expect.unreachable('should have thrown');
		} catch (error) {
			expect((error as InterpreterError).code).toBe('inflate.empty');
		}
	});

	it('throws on a corrupt frame rather than returning short bytes', () => {
		const corrupt = new Uint8Array([40, 181, 47, 253, 9, 9, 9, 9]);
		try {
			inflateZstd(corrupt);
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(InterpreterError);
			expect((error as InterpreterError).code).toBe('inflate.corrupt');
		}
	});

	it('throws when the frame header disagrees with the declared size', () => {
		try {
			inflateZstd(EMPTY_WASM_ZSTD, { inflatedSize: 4096 });
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(InterpreterError);
			expect((error as InterpreterError).code).toBe('inflate.size-mismatch');
			expect((error as InterpreterError).message).toMatch(/declares 8 inflated bytes/);
		}
	});

	it('accepts a declared size that matches the frame header', () => {
		expect(inflateZstd(EMPTY_WASM_ZSTD, { inflatedSize: 8 })).toStrictEqual(EMPTY_WASM);
	});
});

describe('wasmModuleFromZstd', () => {
	// every call in the workers pool is a request-time call, so workerd refuses codegen here
	// exactly as it would in a handler. The successful compile is covered in the node project,
	// tests/interpreters/inflate-compile.spec.ts
	it('names the embedder refusal rather than blaming the bytes', () => {
		try {
			wasmModuleFromZstd(EMPTY_WASM_ZSTD);
			expect.unreachable('workerd should refuse request-time codegen');
		} catch (error) {
			expect(error).toBeInstanceOf(InterpreterError);
			expect((error as InterpreterError).code).toBe('inflate.codegen-disallowed');
			expect((error as InterpreterError).message).toMatch(/module scope/);
		}
	});

	it('propagates the inflate failure rather than reporting a codegen failure', () => {
		try {
			wasmModuleFromZstd(new Uint8Array(0));
			expect.unreachable('should have thrown');
		} catch (error) {
			expect((error as InterpreterError).code).toBe('inflate.empty');
		}
	});
});

describe('zstdContentSize', () => {
	it('reads the declared length out of a real frame', () => {
		expect(zstdContentSize(EMPTY_WASM_ZSTD)).toBe(8);
	});

	it('returns undefined when the bytes are not a zstd frame', () => {
		expect(zstdContentSize(EMPTY_WASM)).toBeUndefined();
	});

	it('returns undefined on a truncated header rather than reading past the end', () => {
		expect(zstdContentSize(EMPTY_WASM_ZSTD.subarray(0, 5))).toBeUndefined();
	});

	it('reads the 4-byte size field the real interpreter frames use', () => {
		// header of the zstd frame for the 12,218,400-byte PHP 8.5 binary: descriptor 164 is
		// sizeFlag 2 (a 4-byte field), single-segment, no dictionary. The embedded fixture above
		// only exercises the 1-byte field, which is NOT the shape production ships
		const header = new Uint8Array([40, 181, 47, 253, 164, 32, 112, 186, 0, 36, 42, 0]);
		expect(zstdContentSize(header)).toBe(12218400);
	});
});
