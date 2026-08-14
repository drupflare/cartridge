import { describe, expect, it } from 'vitest';
import { CartridgeError } from '../src/errors.js';
import {
	concatBytes,
	decodeJson,
	encodeJson,
	fromUtf8,
	splitLines,
	toBytes,
	toUtf8
} from '../src/util.js';

/**
 * The conveniences that keep a `TextEncoder` out of caller code.
 *
 * These are small enough to look untestable, which is exactly why the round trips are here: a codec
 * that can decode a type it cannot encode is the failure this bracket exists to catch, and it is not
 * visible from either half alone.
 */

describe('fromUtf8 / toUtf8', () => {
	it('round-trips ASCII', () => {
		expect(toUtf8(fromUtf8('hello'))).toBe('hello');
	});

	it('round-trips multi-byte text byte for byte', () => {
		const text = 'café 日本語 \u{1f600}';
		const bytes = fromUtf8(text);
		// 4-byte astral plane, 3-byte CJK and 2-byte latin-1 all in one string
		expect(bytes.length).toBeGreaterThan(text.length);
		expect(toUtf8(bytes)).toBe(text);
	});

	it('encodes the empty string to zero bytes', () => {
		expect(fromUtf8('').length).toBe(0);
		expect(toUtf8(new Uint8Array(0))).toBe('');
	});

	it('replaces an invalid sequence rather than throwing', () => {
		// a lone continuation byte; decoding must not blow up a whole run over one bad byte
		expect(toUtf8(new Uint8Array([0x80]))).toBe('�');
	});
});

describe('encodeJson / decodeJson', () => {
	it('round-trips an object', () => {
		const value = { a: 1, b: ['x', null], c: { d: true } };
		expect(decodeJson(encodeJson(value))).toEqual(value);
	});

	it('round-trips a bare scalar', () => {
		expect(decodeJson(encodeJson(42))).toBe(42);
		expect(decodeJson(encodeJson('text'))).toBe('text');
		expect(decodeJson(encodeJson(null))).toBe(null);
	});

	it('refuses a cycle by name', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		try {
			encodeJson(cyclic);
			expect.unreachable('a cycle must not encode');
		} catch (error) {
			expect(error).toBeInstanceOf(CartridgeError);
			expect((error as CartridgeError).code).toBe('util.bad_json_input');
		}
	});

	it('refuses undefined, which JSON.stringify answers silently', () => {
		// the trap: JSON.stringify(undefined) returns undefined with no throw, so an unguarded
		// encoder would produce the four bytes "unde" from a String() cast
		try {
			encodeJson(undefined);
			expect.unreachable('undefined must not encode');
		} catch (error) {
			expect((error as CartridgeError).code).toBe('util.bad_json_input');
			expect((error as Error).message).toContain('undefined');
		}
	});

	it('refuses a function for the same reason', () => {
		expect(() => encodeJson(() => 1)).toThrow(CartridgeError);
	});

	it('names the input when the bytes are not JSON', () => {
		try {
			decodeJson(fromUtf8('PHP Warning: something went wrong'));
			expect.unreachable('a warning is not JSON');
		} catch (error) {
			expect((error as CartridgeError).code).toBe('util.bad_json_output');
			// the first 200 chars are in the message, because a parse failure with no sight of the
			// input is the least actionable error there is
			expect((error as Error).message).toContain('PHP Warning');
		}
	});

	it('truncates a very long non-JSON input to 200 characters', () => {
		const long = 'x'.repeat(5000);
		try {
			decodeJson(fromUtf8(long));
			expect.unreachable('not JSON');
		} catch (error) {
			expect((error as Error).message).toContain('x'.repeat(200));
			expect((error as Error).message).not.toContain('x'.repeat(201));
		}
	});
});

describe('toBytes', () => {
	it('encodes a string', () => {
		expect(toBytes('ab')).toEqual(new Uint8Array([97, 98]));
	});

	it('passes bytes through without copying', () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(toBytes(bytes)).toBe(bytes);
	});
});

describe('concatBytes', () => {
	it('joins chunks in order', () => {
		expect(concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])])).toEqual(
			new Uint8Array([1, 2, 3])
		);
	});

	it('answers an empty buffer for no chunks', () => {
		expect(concatBytes([]).length).toBe(0);
	});

	it('returns a single chunk as-is rather than copying it', () => {
		const only = new Uint8Array([9]);
		expect(concatBytes([only])).toBe(only);
	});

	it('skips empty chunks without disturbing the offsets', () => {
		expect(concatBytes([new Uint8Array(0), new Uint8Array([5]), new Uint8Array(0)])).toEqual(
			new Uint8Array([5])
		);
	});
});

describe('splitLines', () => {
	it('splits on newlines', () => {
		expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
	});

	it('drops ONE trailing newline, which is what a well-formed program emits', () => {
		// without this, lastLine() answers '' for every program that ended its output properly
		expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
	});

	it('keeps a deliberate blank final line', () => {
		expect(splitLines('a\n\n')).toEqual(['a', '']);
	});

	it('strips CR so CRLF output does not carry it into every line', () => {
		expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
	});

	it('answers no lines for empty text', () => {
		expect(splitLines('')).toEqual([]);
	});

	it('treats a lone newline as one empty line', () => {
		expect(splitLines('\n')).toEqual(['']);
	});
});
