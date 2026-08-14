/**
 * Ship the interpreter pre-compressed and inflate it at module scope.
 *
 * Cloudflare measures a Worker's size AFTER ITS OWN GZIP, and you do not get to
 * choose that compressor. You do get to choose what state the bytes are in when they reach it, and
 * gzip cannot shrink data that is already well compressed. So a wasm binary shipped as a `Data`
 * module holding a zstd frame passes through the meter at roughly its zstd size. Measured on the
 * PHP 8.5 interpreter, on wrangler's own reported figure: 3,641,600 as `CompiledWasm` against
 * 2,643,722 as a zstd blob, a 997,878-byte difference that decides whether the binary fits the
 * 3 MiB free ceiling at all.
 *
 * Cloudflare reported a startup time of 233/234/246 ms (n=3) for a 12,218,400-byte interpreter against
 * a 1,000 ms startup limit, and that cost is NOT billed to the request: three requests that ran on cold
 * isolates reported cpuTime of 1, 0 and 0 ms. It is paid once per isolate.
 *
 * @example
 * ```ts
 * import { wasmModuleFromZstd } from '@drupflare/cartridge/inflate';
 * import blob from '../vendor/php.wasm.zst';
 *
 * // the frame header carries the inflated length, so passing it is an optional cross-check
 * const wasmModule = wasmModuleFromZstd(blob);
 * ```
 */

import { decompress } from 'fzstd';
import { InterpreterError } from './errors';

/** Options for {@link wasmModuleFromZstd} and {@link inflateZstd}. */
export interface InflateOptions {
	/**
	 * Expected inflated byte length, as a cross-check against the frame's own header.
	 *
	 * Optional, because {@link zstdContentSize} reads the real length out of the frame and the
	 * decompressor is pre-sized from that either way. Supplying it turns a silently-swapped binary
	 * into a thrown error at startup.
	 */
	inflatedSize?: number;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

// workers-types models WebAssembly.Module as abstract, because the usual way to get one is a
// CompiledWasm import rather than a constructor call. The constructor does exist at runtime and is
// the whole point here; a deployed worker compiled a 12 MB binary through it
const WasmModule = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;

/**
 * Read the declared uncompressed length out of a zstd frame header.
 *
 * Returns `undefined` when the frame omits the field, which is legal for streamed frames. The
 * project's own frames are produced by the `zstd` CLI over a whole file and always carry it.
 *
 * @param frame - the first bytes of a zstd frame; only the header is read
 */
export function zstdContentSize(frame: Uint8Array): number | undefined {
	if (frame.byteLength < 6 || !ZSTD_MAGIC.every((byte, index) => frame[index] === byte)) {
		return undefined;
	}
	const descriptor = frame[4] ?? 0;
	const sizeFlag = (descriptor >> 6) & 3;
	const singleSegment = ((descriptor >> 5) & 1) === 1;
	const dictionaryIdFlag = descriptor & 3;

	let offset = 5;
	if (!singleSegment) offset += 1; // window descriptor
	offset += dictionaryIdFlag === 3 ? 4 : dictionaryIdFlag;

	// flag 0 means "absent", except on a single-segment frame where it means one byte
	const width = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 2 << (sizeFlag - 1);
	if (width === 0 || offset + width > frame.byteLength) return undefined;

	let value = 0;
	for (let index = width - 1; index >= 0; index--) {
		value = value * 256 + (frame[offset + index] ?? 0);
	}
	// the 2-byte form is stored biased by 256; the others are not
	return width === 2 ? value + 256 : value;
}

/**
 * Inflate a zstd frame to its raw bytes.
 *
 * The escape hatch under {@link wasmModuleFromZstd}: use it when you need the bytes for something
 * other than a module, such as hashing the binary or writing it to storage.
 *
 * @param blob - the zstd frame, as imported from a wrangler `Data` module rule
 * @throws {InterpreterError} if the frame does not inflate, or inflates to the wrong length
 */
export function inflateZstd(
	blob: ArrayBuffer | Uint8Array,
	options: InflateOptions = {}
): Uint8Array {
	const framed = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
	if (framed.byteLength === 0) {
		throw new InterpreterError(
			'the zstd blob is empty; the Data module rule probably did not match',
			'inflate.empty'
		);
	}

	// checked BEFORE inflating, against the frame header rather than the output buffer. Comparing
	// the result length to a caller-supplied size cannot fail when the buffer is pre-sized: fzstd
	// returns the buffer it was handed, so the two are equal by construction
	const declared = zstdContentSize(framed);
	const { inflatedSize } = options;
	if (inflatedSize !== undefined && declared !== undefined && declared !== inflatedSize) {
		throw new InterpreterError(
			`the zstd frame declares ${declared} inflated bytes, expected ${inflatedSize}`,
			'inflate.size-mismatch'
		);
	}

	try {
		// pre-sized from the frame's own header, so one exact allocation replaces growing and
		// copying a multi-megabyte buffer
		return declared === undefined
			? decompress(framed)
			: decompress(framed, new Uint8Array(declared));
	} catch (cause) {
		throw new InterpreterError(
			`the zstd blob did not inflate: ${cause instanceof Error ? cause.message : String(cause)}`,
			'inflate.corrupt'
		);
	}
}

/**
 * Inflate a zstd-compressed wasm binary and compile it.
 *
 * The default path: one call at module scope replaces a `CompiledWasm` import. Call it at module
 * scope only -- workerd forbids wasm codegen at request time, so calling it from a handler throws
 * from the platform rather than from here.
 *
 * @param blob - the zstd frame, as imported from a wrangler `Data` module rule
 * @throws {InterpreterError} if the frame does not inflate, or does not compile as wasm
 */
export function wasmModuleFromZstd(
	blob: ArrayBuffer | Uint8Array,
	options: InflateOptions = {}
): WebAssembly.Module {
	const bytes = inflateZstd(blob, options);
	try {
		return new WasmModule(bytes);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		// the embedder refusal and bad bytes are different faults with the same throw site, and
		// reporting the wrong one sends the reader looking for a corrupt binary that is fine
		if (/code generation disallowed/i.test(message)) {
			throw new InterpreterError(
				'workerd refused wasm codegen, so this ran at request time; call it at module scope instead',
				'inflate.codegen-disallowed'
			);
		}
		throw new InterpreterError(
			`the inflated bytes are not a loadable wasm module: ${message}`,
			'inflate.not-wasm'
		);
	}
}
