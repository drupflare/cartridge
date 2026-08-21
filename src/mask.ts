import { MaskViolationError } from './errors';

// thrown by the dev assertions; declared in errors.ts so the whole vocabulary reads in one file,
// re-exported here so every existing `from './mask.js'` import still names the same class
export { MaskViolationError };

/** `zend_wasm_slice_stat(0)` -- total interrupt fires, masked or not */
export const SLICE_STAT_FIRES = 0;
/** `zend_wasm_slice_stat(4)` -- the C-side mask depth, NOT the host depth */
export const SLICE_STAT_MASK = 4;

/**
 * An emscripten Module, narrowed to the three exports the interrupt patch adds.
 *
 * All optional because a build without the patch is the normal case: `vmFromBinary()` answers
 * null for it and the mask degrades to a host-call counter.
 */
export interface MaskBinary {
	_zend_wasm_slice_mask?: (on: number) => unknown;
	_zend_wasm_slice_stat?: (which: number) => number;
	_zend_wasm_slice_raise?: () => unknown;
}

/**
 * The VM adapter the mask drives.
 *
 * `stat` and `raise` are nullable rather than absent because which of them a binary has is the
 * thing the mask branches on, and `raise` is the one no build exports yet.
 */
export interface MaskVm {
	mask: (on: unknown) => unknown;
	stat: ((which: number) => number) | null;
	raise: (() => boolean) | null;
}

/** what `configure()` reports back: which seams are wired, not their values */
export interface MaskConfig {
	vm: boolean;
	budgetExceeded: boolean;
	dev: boolean;
	raise: boolean;
}

/** every way the mask can go wrong or be exercised, counted */
export interface MaskCounters {
	enters: number;
	nested: number;
	maxDepth: number;
	deferred: number;
	budgetDeferred: number;
	raised: number;
	consumed: number;
	violations: number;
	budgetChecks: number;
}

/** the counters plus the live state, which is what a diagnostic route reads */
export type MaskStats = MaskCounters & {
	depth: number;
	pending: boolean;
	hasVm: boolean;
	hasRaise: boolean;
};

/** the seams `createMask()` and `configure()` accept; `dev` defaults to on */
export interface MaskOptions {
	vm?: MaskVm | null;
	budgetExceeded?: (() => boolean) | null;
	dev?: boolean;
}

/** one refcounted mask instance */
export interface Mask {
	enter: () => number;
	exit: () => number;
	withMask: <T>(fn: () => T) => T;
	depth: () => number;
	pending: () => boolean;
	takePending: () => boolean;
	raise: () => boolean;
	assertSuspendable: (where?: string) => boolean;
	configure: (next?: MaskOptions) => MaskConfig;
	stats: () => MaskStats;
	reset: () => void;
}

/**
 * Builds the VM adapter the mask drives, from an emscripten Module.
 *
 * Returns null on a binary without the interrupt patch, which is the correct
 * answer for every non-JSPI build: the mask then degrades to a plain host-call
 * counter and the wired call sites need no conditional.
 *
 * `raise` is optional and is the one export the patch does not have yet; see
 * TECHNICAL_REPORT.md, "the mask seam", for the exact C addition. Without it a deferred
 * interrupt lands at the next natural tick instead of immediately.
 */
export function vmFromBinary(binary?: MaskBinary | null): MaskVm | null {
	const m = binary?._zend_wasm_slice_mask;
	if (typeof m !== 'function') return null;
	const s = binary?._zend_wasm_slice_stat;
	const r = binary?._zend_wasm_slice_raise;
	return {
		mask: (on: unknown) => m(on ? 1 : 0),
		stat: typeof s === 'function' ? (which: number) => s(which) : null,
		raise: typeof r === 'function' ? () => !!r() : null
	};
}

/**
 * One refcounted interrupt mask, shared by every host call that enters JS.
 *
 * The depth this tracks is the HOST depth. The C handler masks itself for the
 * duration of its own yield, so `zend_wasm_slice_stat(4)` reads 1 inside
 * `cfwVmYield` and that is correct, not a violation -- never assert on it.
 *
 * A mask must never span an await. Every wired call site is synchronous because
 * PHP is blocked inside it, and that is what makes a module-level singleton safe
 * when one isolate holds several Durable Objects: depth returns to 0 before
 * control leaves the JS turn. `withMask()` refuses a thenable body in dev to
 * keep it that way.
 */
export function createMask(options: MaskOptions = {}): Mask {
	let vm: MaskVm | null = options.vm ?? null;
	let budgetExceeded: (() => boolean) | null = options.budgetExceeded ?? null;
	let dev = options.dev !== false;

	let depth = 0;
	let pending = false;
	let firesAtEnter = 0;

	const counters: MaskCounters = {
		enters: 0,
		nested: 0,
		maxDepth: 0,
		deferred: 0,
		budgetDeferred: 0,
		raised: 0,
		consumed: 0,
		violations: 0,
		budgetChecks: 0
	};

	function readFires(): number {
		return vm && vm.stat ? vm.stat(SLICE_STAT_FIRES) : 0;
	}

	function configure(next: MaskOptions = {}): MaskConfig {
		if ('vm' in next) vm = next.vm ?? null;
		if ('budgetExceeded' in next) budgetExceeded = next.budgetExceeded ?? null;
		if ('dev' in next) dev = next.dev !== false;
		return {
			vm: !!vm,
			budgetExceeded: !!budgetExceeded,
			dev,
			raise: !!vm?.raise
		};
	}

	function enter(): number {
		if (depth === 0) {
			// baseline BEFORE the mask goes on: a fire inside the window is only visible
			// as a delta, because C drops the flag instead of deferring it
			firesAtEnter = readFires();
			if (vm) vm.mask(1);
		} else {
			counters.nested++;
		}
		depth++;
		counters.enters++;
		if (depth > counters.maxDepth) counters.maxDepth = depth;
		return depth;
	}

	function exit(): number {
		if (depth === 0) {
			counters.violations++;
			if (dev) {
				throw new MaskViolationError('maskExit() at depth 0: unbalanced mask');
			}
			return 0;
		}
		depth--;
		if (depth > 0) return depth;
		// unmask first: the C raise refuses while its own mask is nonzero
		if (vm) vm.mask(0);
		if (readFires() !== firesAtEnter) {
			pending = true;
			counters.deferred++;
		}
		if (budgetExceeded) {
			counters.budgetChecks++;
			if (budgetExceeded()) {
				pending = true;
				counters.budgetDeferred++;
			}
		}
		if (pending) raise();
		return 0;
	}

	/**
	 * Pushes the pending boundary into the VM if the binary can take it.
	 *
	 * Returns true only when the interrupt is now armed in C. False leaves the flag
	 * set for the poll site to consume with `takePending()`, which is the fallback
	 * on a binary without `zend_wasm_slice_raise`.
	 */
	function raise(): boolean {
		pending = true;
		if (depth > 0) return false;
		if (vm && vm.raise && vm.raise()) {
			pending = false;
			counters.raised++;
			return true;
		}
		return false;
	}

	function takePending(): boolean {
		if (!pending) return false;
		pending = false;
		counters.consumed++;
		return true;
	}

	/**
	 * The poll site's guard. Loud in dev, fail-safe in prod: a false return means
	 * "do not suspend here, keep running", which costs a slice boundary instead of
	 * throwing SuspendError into the middle of a render.
	 */
	function assertSuspendable(where = 'suspend'): boolean {
		if (depth === 0) return true;
		counters.violations++;
		if (dev) {
			throw new MaskViolationError(
				`${where}: suspension attempted at mask depth ${depth}, so a JS frame is under the PHP stack`
			);
		}
		return false;
	}

	function withMask<T>(fn: () => T): T {
		enter();
		try {
			const out = fn();
			if (dev && out && typeof (out as { then?: unknown }).then === 'function') {
				throw new MaskViolationError(
					'withMask() body returned a thenable; a mask must not span an await'
				);
			}
			return out;
		} finally {
			exit();
		}
	}

	function snapshot(): MaskStats {
		return { ...counters, depth, pending, hasVm: !!vm, hasRaise: !!vm?.raise };
	}

	function reset(): void {
		depth = 0;
		pending = false;
		firesAtEnter = 0;
		for (const k of Object.keys(counters) as (keyof MaskCounters)[]) counters[k] = 0;
	}

	return {
		enter,
		exit,
		withMask,
		depth: () => depth,
		pending: () => pending,
		takePending,
		raise,
		assertSuspendable,
		configure,
		stats: snapshot,
		reset
	};
}

/**
 * The process-wide mask. One PHP instance has one C-side mask counter, so the
 * wired call sites share this rather than threading an instance through the FS
 * and the bridge; `createMask()` stays exported for tests and for the case of two
 * interpreters in one isolate.
 */
export const mask = createMask();

export const maskEnter = mask.enter;
export const maskExit = mask.exit;
export const withMask = mask.withMask;
export const maskDepth = mask.depth;
export const pendingInterrupt = mask.pending;
export const takePendingInterrupt = mask.takePending;
export const raisePendingInterrupt = mask.raise;
export const assertSuspendable = mask.assertSuspendable;
export const configureMask = mask.configure;
export const maskStats = mask.stats;
export const resetMask = mask.reset;
