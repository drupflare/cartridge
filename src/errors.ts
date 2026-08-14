/**
 * The error vocabulary. Five names, one base, and every one of them carries a dotted `code`.
 *
 * The `code` is dotted and stable, and it uses the same shape as `supervisor.ts`'s `Finding.code`
 * on purpose: a thrown error and a recorded finding about the same defect can then be correlated
 * without a translation table.
 */

/**
 * Base for everything this package throws.
 *
 * `instanceof CartridgeError` is the "something in the cartridge layer failed" check; the subclass
 * is the "which seam" check.
 */
export class CartridgeError extends Error {
	/** stable dotted identifier; safe to branch on, unlike the message */
	readonly code: string;

	constructor(message: string, code = 'cartridge.error') {
		super(message);
		this.name = 'CartridgeError';
		this.code = code;
	}
}

/**
 * The reentrancy gate was misused.
 *
 * THE FAILURE THIS NAMES IS NOT A THROW, WHICH IS WHY IT NEEDED A NAME. Acquiring the gate a second
 * time inside a call that already holds it hangs **forever** -- `alarm()` is not gated as a whole
 * while `fetch()` is -- and it presents as a deadlock while actually being starvation. A failing
 * step that re-armed at +1 ms once spun an object forever and starved every gated request past 90 s.
 * Nothing threw, so nothing was reported. This error exists so the detectable half of that
 * (a run submitted to a closed gate, a drain that never settles) fails loudly instead.
 */
export class GateError extends CartridgeError {
	constructor(message: string, code = 'gate.error') {
		super(message, code);
		this.name = 'GateError';
	}
}

/**
 * An unbalanced mask, a mask that spans an await, or a suspension attempted while a JS frame is
 * under the interpreter's stack.
 *
 * Declared here rather than in `mask.ts` so the whole vocabulary reads in one file; `mask.ts`
 * re-exports it, so `import { MaskViolationError } from '@drupflare/cartridge/mask'` still works and
 * refers to this exact class.
 */
export class MaskViolationError extends CartridgeError {
	constructor(message: string, code = 'mask.violation') {
		super(message, code);
		this.name = 'MaskViolationError';
	}
}

/**
 * A filesystem or pack operation failed: a layer that is not reachable, an index entry naming a
 * layer that was never fetched, a write into a path the FS refused.
 */
export class MountError extends CartridgeError {
	constructor(message: string, code = 'mount.error') {
		super(message, code);
		this.name = 'MountError';
	}
}

/**
 * A budget was exhausted: a CPU slice, a resident-bytes ceiling, an interrupt that could not be
 * delivered.
 *
 * Separate from `InterpreterError` because the interpreter did not do anything wrong -- it ran out
 * of an allowance the host set, and the right response is usually to resume elsewhere rather than to
 * report a fault.
 */
export class BudgetError extends CartridgeError {
	constructor(message: string, code = 'budget.exceeded') {
		super(message, code);
		this.name = 'BudgetError';
	}
}

/**
 * The interpreter itself failed: instantiation threw, it exposes no entry point, it exited nonzero
 * where the caller asked for success, or it produced output that was not the shape requested.
 */
export class InterpreterError extends CartridgeError {
	constructor(message: string, code = 'interpreter.error') {
		super(message, code);
		this.name = 'InterpreterError';
	}
}

/** every class in the vocabulary, so a caller can enumerate what it might catch */
export const ERROR_CLASSES = [
	CartridgeError,
	GateError,
	MaskViolationError,
	MountError,
	BudgetError,
	InterpreterError
] as const;

/**
 * Whether a value is one of this package's errors.
 *
 * A type guard rather than a bare `instanceof` because a caller usually wants the narrowing and the
 * `code` at once, and because it keeps the base-class name out of every call site.
 */
export function isCartridgeError(value: unknown): value is CartridgeError {
	return value instanceof CartridgeError;
}
