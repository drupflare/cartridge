import { describe, expect, it } from 'vitest';
import { InterpreterError } from '../src/errors';
import {
	_zstdDecoderFromExports,
	inflateZstd,
	wasmModuleFromZstd,
	zstdContentSize
} from '../src/inflate';

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
	// tests/node/inflate-compile.spec.ts
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

/**
 * The wasm decoder, driven over its exports rather than over a module.
 *
 * A fake decoder, and the fake is the instrument -- the same bracket `mount.spec.ts` uses for
 * MEMFS. Everything the closure does is a sequence of `malloc`/view/`ZSTD_decompress`/`free` calls
 * against a linear memory, and the ORDER is the behaviour: a view taken before the last `malloc`
 * reads a detached buffer and copies nothing, which is silent rather than fatal. The fake grows
 * its memory on demand so that ordering is testable at all.
 *
 * Driven through `_zstdDecoderFromExports` because workerd forbids wasm codegen at request time,
 * so this lane cannot construct the `WebAssembly.Module` the public entry point takes.
 * `tests/node/inflate-compile.spec.ts` covers the instantiation half where codegen is allowed.
 */
interface FakeDecoder {
	exports: Record<string, unknown>;
	freed: number[];
	mallocs: number[];
	/** what a decode writes into the output pointer */
	payload: Uint8Array;
	/** the value ZSTD_decompress returns; undefined means "however many bytes were written" */
	returns?: number;
	/** what ZSTD_isError answers */
	errors: boolean;
	/** grow the memory on this malloc call, which detaches every view taken before it */
	growOn?: number;
	/** the bytes the decoder saw at the input pointer, recorded on decompress */
	sawInput?: Uint8Array;
}

function fakeDecoder(payload: Uint8Array, options: Partial<FakeDecoder> = {}): FakeDecoder {
	const state: FakeDecoder = { exports: {}, freed: [], mallocs: [], payload, errors: false };
	Object.assign(state, options);

	// a REAL WebAssembly.Memory, because only a real grow() detaches the old ArrayBuffer, and the
	// detachment is what the ordering assertion below measures
	const memory = new WebAssembly.Memory({ initial: 1 });
	// starts at 8 so a real pointer is never 0, which is how the OOM branch is signalled
	let next = 8;
	let calls = 0;

	state.exports = {
		memory,
		malloc(size: number): number {
			calls++;
			state.mallocs.push(size);
			if (state.growOn === calls) memory.grow(1);
			const ptr = next;
			next += size;
			return ptr;
		},
		free(ptr: number): void {
			state.freed.push(ptr);
		},
		ZSTD_decompress(dst: number, dstCap: number, src: number, srcSize: number): number {
			state.sawInput = new Uint8Array(memory.buffer, src, srcSize).slice();
			const written = Math.min(state.payload.length, dstCap);
			new Uint8Array(memory.buffer, dst, written).set(state.payload.subarray(0, written));
			return state.returns ?? written;
		},
		ZSTD_isError(): number {
			return state.errors ? 1 : 0;
		}
	};
	return state;
}

/** a frame header declaring 8 inflated bytes, so the decoder can size its own output */
const FRAME = EMPTY_WASM_ZSTD;
const PAYLOAD = EMPTY_WASM;

describe('_zstdDecoderFromExports', () => {
	it('decodes into a view onto the decoder memory, sized from the frame header', () => {
		const decoder = fakeDecoder(PAYLOAD);
		const out = _zstdDecoderFromExports(decoder.exports)(FRAME, undefined);
		expect(out).toStrictEqual(PAYLOAD);
		// the output allocation is never freed: this runs once per isolate at module scope, and a
		// free would invalidate the view the caller is about to compile
		expect(decoder.freed).toHaveLength(1);
		expect(decoder.mallocs).toEqual([FRAME.byteLength, PAYLOAD.byteLength]);
	});

	it('copies the frame in before decoding, so the decoder sees the real input', () => {
		const decoder = fakeDecoder(PAYLOAD);
		_zstdDecoderFromExports(decoder.exports)(FRAME, undefined);
		expect(decoder.sawInput).toStrictEqual(FRAME);
	});

	it('still copies the frame when the second malloc grows the memory', () => {
		// the ordering assertion: `new Uint8Array(memory.buffer, ...)` taken before the output
		// malloc would point at a detached buffer, and the input copy would land nowhere while
		// every other observable stayed correct
		const decoder = fakeDecoder(PAYLOAD, { growOn: 2 });
		const out = _zstdDecoderFromExports(decoder.exports)(FRAME, undefined);
		expect(decoder.sawInput).toStrictEqual(FRAME);
		expect(out).toStrictEqual(PAYLOAD);
	});

	it('fills a caller-supplied buffer and hands that one back', () => {
		const decoder = fakeDecoder(PAYLOAD);
		const into = new Uint8Array(PAYLOAD.byteLength);
		const out = _zstdDecoderFromExports(decoder.exports)(FRAME, into);
		expect(out).toBe(into);
		expect(into).toStrictEqual(PAYLOAD);
	});

	it('sizes from the supplied buffer rather than the header when both are present', () => {
		const decoder = fakeDecoder(PAYLOAD);
		_zstdDecoderFromExports(decoder.exports)(FRAME, new Uint8Array(PAYLOAD.byteLength));
		expect(decoder.mallocs[1]).toBe(PAYLOAD.byteLength);
	});

	it('refuses a frame that declares no size when no buffer was supplied', () => {
		const decoder = fakeDecoder(PAYLOAD);
		try {
			_zstdDecoderFromExports(decoder.exports)(PAYLOAD, undefined);
			expect.unreachable('the payload is not a zstd frame, so it declares nothing');
		} catch (error) {
			expect((error as InterpreterError).code).toBe('inflate.no-declared-size');
		}
	});

	it('reports an allocation failure as OOM with the total it asked for', () => {
		const decoder = fakeDecoder(PAYLOAD);
		decoder.exports.malloc = () => 0;
		try {
			_zstdDecoderFromExports(decoder.exports)(FRAME, undefined);
			expect.unreachable('malloc answered 0');
		} catch (error) {
			expect((error as InterpreterError).code).toBe('inflate.decoder-oom');
			expect((error as Error).message).toContain(
				String(FRAME.byteLength + PAYLOAD.byteLength)
			);
		}
	});

	it('reports a decoder error code as corruption and releases the output', () => {
		const decoder = fakeDecoder(PAYLOAD, { errors: true });
		try {
			_zstdDecoderFromExports(decoder.exports)(FRAME, undefined);
			expect.unreachable('ZSTD_isError answered nonzero');
		} catch (error) {
			expect((error as InterpreterError).code).toBe('inflate.corrupt');
		}
		// both pointers, or a failed decode leaks the whole output allocation
		expect(decoder.freed).toHaveLength(2);
	});

	it('refuses a short decode even when the decoder calls it a success', () => {
		// this is the one that catches a truncated frame: ZSTD_isError is 0 and the bytes are
		// simply incomplete, so only the length comparison notices
		const decoder = fakeDecoder(PAYLOAD, { returns: 3 });
		try {
			_zstdDecoderFromExports(decoder.exports)(FRAME, undefined);
			expect.unreachable('the decoder wrote 3 of 8 bytes');
		} catch (error) {
			expect((error as InterpreterError).code).toBe('inflate.corrupt');
			expect((error as Error).message).toMatch(/returned 3 for a frame declaring 8/);
		}
	});

	it('calls _initialize when the module exports one', () => {
		const decoder = fakeDecoder(PAYLOAD);
		let initialised = 0;
		decoder.exports._initialize = () => {
			initialised++;
		};
		_zstdDecoderFromExports(decoder.exports);
		expect(initialised).toBe(1);
	});

	it.each(['memory', 'malloc', 'free', 'ZSTD_decompress', 'ZSTD_isError'])(
		'names %s when the module does not export it',
		(missing) => {
			const decoder = fakeDecoder(PAYLOAD);
			delete decoder.exports[missing];
			try {
				_zstdDecoderFromExports(decoder.exports);
				expect.unreachable('the export is missing');
			} catch (error) {
				expect((error as InterpreterError).code).toBe('inflate.decoder-incomplete');
				expect((error as Error).message).toContain(missing);
			}
		}
	);

	it('plugs into inflateZstd as the documented decompress option', () => {
		// the seam the whole function exists for: 25,000 bytes of wasm decoder in place of the
		// pure-JS default, which measured as 94% of a 274 ms startup
		const decoder = fakeDecoder(PAYLOAD);
		const out = inflateZstd(FRAME, { decompress: _zstdDecoderFromExports(decoder.exports) });
		expect(out).toStrictEqual(PAYLOAD);
	});

	it('reports a throwing decoder as a corrupt inflate rather than escaping inflateZstd', () => {
		const decoder = fakeDecoder(PAYLOAD, { errors: true });
		try {
			inflateZstd(FRAME, { decompress: _zstdDecoderFromExports(decoder.exports) });
			expect.unreachable('should have thrown');
		} catch (error) {
			expect((error as InterpreterError).code).toBe('inflate.corrupt');
		}
	});
});
