/**
 * Ship the interpreter pre-compressed and inflate it at module scope.
 *
 * Cloudflare measures a Worker's size **after its own gzip**, and you do not get to
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

/**
 * A synchronous zstd decompressor.
 *
 * `fzstd` satisfies this, and so does {@link zstdDecoderFromWasm}.
 */
export type ZstdDecompress = (frame: Uint8Array, into: Uint8Array | undefined) => Uint8Array;

/** Options for {@link wasmModuleFromZstd} and {@link inflateZstd}. */
export interface InflateOptions {
	/**
	 * A decompressor to use instead of the bundled pure-JS one.
	 *
	 * The default costs 5,591 bytes on the size meter and about 257 ms of startup for a 9 MB
	 * interpreter, which measured as 94% of the whole startup cost. {@link zstdDecoderFromWasm}
	 * trades roughly 25,000 bytes for most of that time back.
	 *
	 * @since 0.1.2
	 */
	decompress?: ZstdDecompress;
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

/** what a decoder module has to export before {@link zstdDecoderFromWasm} will drive it */
const DECODER_EXPORTS = ['memory', 'malloc', 'free', 'ZSTD_decompress', 'ZSTD_isError'] as const;

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

	const inflate = options.decompress ?? decompress;
	try {
		// pre-sized from the frame's own header, so one exact allocation replaces growing and
		// copying a multi-megabyte buffer
		return declared === undefined
			? inflate(framed, undefined)
			: inflate(framed, new Uint8Array(declared));
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

/**
 * Build a {@link ZstdDecompress} backed by a zstd decoder compiled to wasm.
 *
 * The pure-JS default is the whole startup cost: measured on a deployed worker, inflating a 9 MB
 * interpreter took ~257 ms of a ~274 ms startup, leaving ~17 ms for the actual
 * `WebAssembly.Module` compile. A wasm decoder imported as `CompiledWasm` is compiled by the
 * platform ahead of the isolate, so it costs ~8 ms to have and decodes far faster.
 *
 * The module must export `memory`, `malloc`, `free`, `ZSTD_decompress` and `ZSTD_isError`, and may
 * export `_initialize`, which is called if present. One import is tolerated and stubbed,
 * `env.emscripten_notify_memory_growth`.
 *
 * @example
 * ```ts
 * import decoder from '../vendor/zstddec.wasm';
 * import blob from '../vendor/php.wasm.zst';
 *
 * const wasmModule = wasmModuleFromZstd(blob, { decompress: zstdDecoderFromWasm(decoder) });
 * ```
 *
 * @since 0.1.2
 * @param module - the decoder, from a wrangler `CompiledWasm` import
 * @throws {InterpreterError} if the module does not expose the expected exports
 */
export function zstdDecoderFromWasm(module: WebAssembly.Module): ZstdDecompress {
	let instance: WebAssembly.Instance;
	try {
		instance = new WebAssembly.Instance(module, {
			// emscripten calls this after memory.grow; there is nothing to notify
			env: { emscripten_notify_memory_growth: () => {} }
		});
	} catch (cause) {
		throw new InterpreterError(
			`the zstd decoder did not instantiate: ${cause instanceof Error ? cause.message : String(cause)}`,
			'inflate.decoder-broken'
		);
	}

	return _zstdDecoderFromExports(instance.exports as Record<string, unknown>);
}

/**
 * Builds a {@link ZstdDecompress} over an already-instantiated decoder's exports.
 *
 * @internal Exported for the gate lane. workerd forbids wasm codegen at request time, so a spec
 * cannot hand {@link zstdDecoderFromWasm} a real `WebAssembly.Module`; driving the exports
 * directly is the only way to exercise the decode itself rather than the instantiation.
 *
 * @param api - the instance's exports
 * @throws {InterpreterError} if an export the decode needs is missing
 */
export function _zstdDecoderFromExports(api: Record<string, unknown>): ZstdDecompress {
	for (const name of DECODER_EXPORTS) {
		if (api[name] === undefined) {
			throw new InterpreterError(
				`the zstd decoder exports no ${name}; it is not a decoder this can drive`,
				'inflate.decoder-incomplete'
			);
		}
	}
	(api._initialize as (() => void) | undefined)?.();

	const memory = api.memory as WebAssembly.Memory;
	const malloc = api.malloc as (size: number) => number;
	const free = api.free as (ptr: number) => void;
	const decompressInto = api.ZSTD_decompress as (
		dst: number,
		dstCap: number,
		src: number,
		srcSize: number
	) => number;
	const isError = api.ZSTD_isError as (code: number) => number;

	return (frame, into) => {
		const outSize = into?.byteLength ?? zstdContentSize(frame);
		if (outSize === undefined) {
			throw new InterpreterError(
				'the frame declares no content size, so the wasm decoder cannot size its output',
				'inflate.no-declared-size'
			);
		}

		const inPtr = malloc(frame.byteLength);
		const outPtr = malloc(outSize);
		if (inPtr === 0 || outPtr === 0) {
			throw new InterpreterError(
				`the decoder could not allocate ${frame.byteLength + outSize} bytes`,
				'inflate.decoder-oom'
			);
		}
		// EVERY view is taken AFTER the last malloc. malloc can grow the memory, and growing
		// detaches the old ArrayBuffer, so a view captured earlier is zero-length and silently
		// copies nothing
		new Uint8Array(memory.buffer, inPtr, frame.byteLength).set(frame);

		const written = decompressInto(outPtr, outSize, inPtr, frame.byteLength);
		free(inPtr);
		if (isError(written) !== 0 || written !== outSize) {
			free(outPtr);
			throw new InterpreterError(
				`the wasm decoder returned ${written} for a frame declaring ${outSize}`,
				'inflate.corrupt'
			);
		}

		// a VIEW onto the decoder's memory rather than a copy: WebAssembly.Module copies the bytes
		// while compiling, so the multi-megabyte second allocation is pure waste. outPtr is
		// deliberately never freed -- this runs once per isolate at module scope
		const out = new Uint8Array(memory.buffer, outPtr, outSize);
		if (into === undefined) return out;
		into.set(out);
		return into;
	};
}
