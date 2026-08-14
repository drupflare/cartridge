import { describe, expect, it } from 'vitest';
import { InterpreterError } from '../../src/errors';
import { inflateZstd, wasmModuleFromZstd, zstdContentSize } from '../../src/inflate';

// the compile half lives here rather than in the workers project because workerd refuses
// wasm codegen outside module scope, and every call in that pool is a request-time call.
// tests/inflate.spec.ts asserts the refusal is reported as such; this asserts the success.
const EMPTY_WASM_ZSTD = new Uint8Array([
	40, 181, 47, 253, 36, 8, 65, 0, 0, 0, 97, 115, 109, 1, 0, 0, 0, 186, 52, 157, 64
]);
const TEXT_ZSTD = new Uint8Array([
	40, 181, 47, 253, 36, 34, 17, 1, 0, 110, 111, 116, 32, 97, 32, 122, 115, 116, 100, 32, 102, 114,
	97, 109, 101, 32, 97, 116, 32, 97, 108, 108, 44, 32, 106, 117, 115, 116, 32, 116, 101, 120, 116,
	43, 9, 145, 137
]);

describe('wasmModuleFromZstd, where codegen is permitted', () => {
	it('inflates and compiles a module', () => {
		expect(wasmModuleFromZstd(EMPTY_WASM_ZSTD)).toBeInstanceOf(WebAssembly.Module);
	});

	it('compiles with a matching declared size', () => {
		const mod = wasmModuleFromZstd(EMPTY_WASM_ZSTD, { inflatedSize: 8 });
		expect(WebAssembly.Module.exports(mod)).toStrictEqual([]);
	});

	it('reports non-wasm bytes as non-wasm, not as a codegen refusal', () => {
		try {
			wasmModuleFromZstd(TEXT_ZSTD);
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(InterpreterError);
			expect((error as InterpreterError).code).toBe('inflate.not-wasm');
		}
	});

	it('round-trips through the raw escape hatch and compiles the same bytes', () => {
		const bytes = inflateZstd(EMPTY_WASM_ZSTD);
		expect(bytes.byteLength).toBe(zstdContentSize(EMPTY_WASM_ZSTD));
		expect(wasmModuleFromZstd(EMPTY_WASM_ZSTD)).toBeInstanceOf(WebAssembly.Module);
	});
});
