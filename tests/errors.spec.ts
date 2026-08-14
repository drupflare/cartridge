import { describe, expect, it } from 'vitest';
import {
	BudgetError,
	CartridgeError,
	ERROR_CLASSES,
	GateError,
	InterpreterError,
	MaskViolationError,
	MountError,
	isCartridgeError
} from '../src/errors.js';
import { MaskViolationError as MaskViolationFromMask } from '../src/mask.js';

/**
 * The vocabulary, and the two properties that make it worth having.
 *
 * A caller has to be able to branch on WHICH seam failed, and matching on a message string is how
 * that turns into a silent break the next time a message is reworded. So every class carries a stable
 * dotted `code`, and every class answers `instanceof CartridgeError`.
 */

describe('the error vocabulary', () => {
	it('gives every class the base type, so one catch can cover the package', () => {
		for (const Cls of ERROR_CLASSES) {
			const error = new Cls('boom');
			expect(error).toBeInstanceOf(CartridgeError);
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toBe('boom');
		}
	});

	it('sets name to the class name rather than leaving it as Error', () => {
		// name is what a serialised log line shows, so a wrong one makes a triage search miss
		expect(new CartridgeError('x').name).toBe('CartridgeError');
		expect(new GateError('x').name).toBe('GateError');
		expect(new MaskViolationError('x').name).toBe('MaskViolationError');
		expect(new MountError('x').name).toBe('MountError');
		expect(new BudgetError('x').name).toBe('BudgetError');
		expect(new InterpreterError('x').name).toBe('InterpreterError');
	});

	it('gives every class a distinct default code', () => {
		const codes = ERROR_CLASSES.map((Cls) => new Cls('x').code);
		expect(codes).toEqual([
			'cartridge.error',
			'gate.error',
			'mask.violation',
			'mount.error',
			'budget.exceeded',
			'interpreter.error'
		]);
		expect(new Set(codes).size).toBe(codes.length);
	});

	it('lets a call site override the code with a specific one', () => {
		expect(new InterpreterError('x', 'interpreter.nonzero_exit').code).toBe(
			'interpreter.nonzero_exit'
		);
	});

	it('uses the dotted shape supervisor findings use, so the two correlate', () => {
		for (const Cls of ERROR_CLASSES) {
			expect(new Cls('x').code).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
		}
	});

	it('is discriminable pairwise, not only against the base', () => {
		// the control: if every class were the base class this would pass vacuously
		expect(new GateError('x')).not.toBeInstanceOf(MountError);
		expect(new MountError('x')).not.toBeInstanceOf(GateError);
		expect(new BudgetError('x')).not.toBeInstanceOf(InterpreterError);
	});
});

describe('isCartridgeError', () => {
	it('accepts every class in the vocabulary', () => {
		for (const Cls of ERROR_CLASSES) {
			expect(isCartridgeError(new Cls('x'))).toBe(true);
		}
	});

	it('rejects a plain Error, a string, null and undefined', () => {
		expect(isCartridgeError(new Error('x'))).toBe(false);
		expect(isCartridgeError('x')).toBe(false);
		expect(isCartridgeError(null)).toBe(false);
		expect(isCartridgeError(undefined)).toBe(false);
	});
});

describe('MaskViolationError re-exported from mask.js', () => {
	it('is the SAME class, not a second one with the same name', () => {
		// two declarations with one name is how `instanceof` starts answering false for a caller who
		// imported from the other module; the re-export is what keeps this true
		expect(MaskViolationFromMask).toBe(MaskViolationError);
		expect(new MaskViolationFromMask('x')).toBeInstanceOf(CartridgeError);
	});
});
