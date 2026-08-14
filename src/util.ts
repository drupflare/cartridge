import { CartridgeError } from './errors.js';

/**
 * Byte and string conveniences, so no caller of this package ever builds a `TextEncoder`.
 *
 * WHY THESE ARE A MODULE AND NOT INLINE. Every seam here moves bytes: a script written into MEMFS,
 * stdout collected out of an emscripten `print`, a pack member inflated from a blob. Each one has a
 * string form that is what a caller actually has, and a bytes form that is what the interpreter
 * actually takes. Making each API accept both and hand back both is the whole ergonomics rule; these
 * are the four functions that let it do that without repeating an encoder in seven files.
 *
 * The naming is fixed on purpose: `to*`/`from*` for codecs, `*Json` for serialise/parse. Learn it
 * once and the rest of the surface is guessable.
 */

/** shared, because constructing one per call is measurable in a hot loop and buys nothing */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * UTF-8 encodes a string.
 *
 * @param text
 *   The string to encode.
 * @returns
 *   Its UTF-8 bytes.
 */
export function fromUtf8(text: string): Uint8Array {
	return encoder.encode(text);
}

/**
 * Decodes UTF-8 bytes to a string.
 *
 * @param bytes
 *   The bytes to decode.
 * @returns
 *   The decoded string; invalid sequences become U+FFFD rather than throwing.
 */
export function toUtf8(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

/**
 * Serialises a value to UTF-8 JSON bytes.
 *
 * @param value
 *   Anything `JSON.stringify` accepts.
 * @returns
 *   The encoded bytes.
 * @throws CartridgeError
 *   When the value cannot be serialised -- a cycle, or a BigInt.
 */
export function encodeJson(value: unknown): Uint8Array {
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch (cause) {
		throw new CartridgeError(
			`could not encode a value as JSON: ${String(cause)}`,
			'util.bad_json_input'
		);
	}
	// stringify answers undefined for undefined and for a function, with no throw
	if (text === undefined) {
		throw new CartridgeError(
			`JSON.stringify produced nothing for a value of type ${typeof value}`,
			'util.bad_json_input'
		);
	}
	return fromUtf8(text);
}

/**
 * Parses UTF-8 JSON bytes.
 *
 * @param bytes
 *   The bytes to parse.
 * @returns
 *   The parsed value.
 * @throws CartridgeError
 *   When the bytes are not JSON. The message carries the first 200 characters, because a parse
 *   failure with no sight of the input is the least actionable error there is.
 */
export function decodeJson<T = unknown>(bytes: Uint8Array): T {
	const text = toUtf8(bytes);
	try {
		return JSON.parse(text) as T;
	} catch (cause) {
		throw new CartridgeError(
			`not JSON (${String(cause)}): ${text.slice(0, 200)}`,
			'util.bad_json_output'
		);
	}
}

/**
 * Widens `string | Uint8Array` to bytes.
 *
 * Every public API in this package that takes a payload takes both and calls this, which is what
 * keeps a `TextEncoder` out of caller code.
 *
 * @param input
 *   A string, which is UTF-8 encoded, or bytes, which pass through unchanged.
 * @returns
 *   The bytes.
 */
export function toBytes(input: string | Uint8Array): Uint8Array {
	return typeof input === 'string' ? fromUtf8(input) : input;
}

/**
 * Concatenates byte chunks into one buffer.
 *
 * @param chunks
 *   The chunks, in order.
 * @returns
 *   One buffer; a single chunk is returned as-is rather than copied.
 */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 0) return new Uint8Array(0);
	const only = chunks[0];
	if (chunks.length === 1 && only) return only;
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

/**
 * Splits text into lines, dropping a single trailing newline.
 *
 * A trailing newline would otherwise produce an empty last element on every well-formed output,
 * which makes `lastLine()` answer `''` for a program that did nothing wrong.
 *
 * @param text
 *   The text to split.
 * @returns
 *   The lines, without their terminators.
 */
export function splitLines(text: string): string[] {
	if (text === '') return [];
	const body = text.endsWith('\n') ? text.slice(0, -1) : text;
	return body.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}
