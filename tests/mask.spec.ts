import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lazyFsRaw from '../src/lazy-fs.ts?raw';
import {
	MaskViolationError,
	SLICE_STAT_FIRES,
	SLICE_STAT_MASK,
	configureMask,
	createMask,
	maskEnter,
	maskExit,
	maskStats,
	pendingInterrupt,
	resetMask,
	takePendingInterrupt,
	vmFromBinary,
	type Mask
} from '../src/mask.js';

/**
 * Ported from `scripts/test-mask.mjs` (123 hand-rolled assertions).
 *
 * The mask is a correctness prerequisite for sliced rendering, not an optimisation. JSPI
 * cannot suspend a stack with a JS frame in it, and `src/runtime/lazy-fs.js` deliberately
 * puts one there on every first `open()` of a file because it calls `fflate.inflateSync`.
 * So every host call that enters JS has to be masked, and the four properties below are
 * each a way that goes silently wrong: refcounted nesting, a pending flag that fires on
 * unmask rather than being dropped, the budget re-checked on unmask, and a dev assertion
 * that suspension never happens above depth 0.
 *
 * The fake `vm` is the whole point. It exposes exactly what the patched binary exposes --
 * `zend_wasm_slice_mask(on)`, `zend_wasm_slice_stat(which)` and the raise export the patch
 * does not have yet -- and its `tick()` models the C side's real behaviour:
 * `zend_wasm_tick_fired()` counts and re-arms the countdown unconditionally but sets
 * `EG(vm_interrupt)` only when the mask is zero. So a fire inside a masked window is
 * visible ONLY as a delta on `stat(0)`, never as a deferred flag, and a host that does not
 * read that delta loses a slice boundary silently.
 *
 * NEVER assert on `zend_wasm_slice_stat(4)`, the C mask. The C handler increments its own
 * mask around its yield, so it reads 1 at exactly the moment suspension is legal; the dev
 * assertion is on HOST depth only. That is tested from both sides below.
 */

// #region the fake VM and the typed seam onto the one untyped JS module left

type FakeVmState = {
	depth: number;
	fires: number;
	flaggedByTick: number;
	raises: number;
	refused: number;
	maskCalls: number[];
	statCalls: number;
};

type FakeVm = {
	state: FakeVmState;
	mask: (on: unknown) => number;
	stat: ((which: number) => number) | null;
	raise: (() => boolean) | null;
	tick: () => void;
};

/**
 * A stand-in for the three EMSCRIPTEN_KEEPALIVE exports.
 *
 * `raise: false` models the binary that exists today (build/patch-vm-interrupt.sh has no
 * raise export); `raise: 'refuse'` models the C guard declining because its own mask is
 * still nonzero. `tick()` is the C countdown reaching zero.
 */
function fakeVm(opts: { raise?: false | 'refuse' } = {}): FakeVm {
	const state: FakeVmState = {
		depth: 0,
		fires: 0,
		flaggedByTick: 0,
		raises: 0,
		refused: 0,
		maskCalls: [],
		statCalls: 0
	};
	return {
		state,
		mask(on) {
			state.maskCalls.push(on ? 1 : 0);
			state.depth += on ? 1 : -1;
			if (state.depth < 0) state.depth = 0;
			return state.depth;
		},
		stat(which) {
			state.statCalls++;
			if (which === SLICE_STAT_FIRES) return state.fires;
			if (which === SLICE_STAT_MASK) return state.depth;
			return 0;
		},
		raise:
			opts.raise === false
				? null
				: () => {
						// the C guard: a raise while masked sets nothing
						if (state.depth > 0 || opts.raise === 'refuse') {
							state.refused++;
							return false;
						}
						state.raises++;
						return true;
					},
		// zend_wasm_tick_fired(): counts and re-arms always, flags only when unmasked
		tick() {
			state.fires++;
			if (state.depth === 0) state.flaggedByTick++;
		}
	};
}

const newMask = (
	options: { vm?: FakeVm | null; budgetExceeded?: (() => boolean) | null; dev?: boolean } = {}
): Mask => createMask(options);

/** calls `fn` once and hands back what it threw, so class and message are both assertable */
function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	return null;
}

/** the lazy-FS source read as text; the wiring is asserted on it, see that region */
const lazyFsSource: string = lazyFsRaw;

// #endregion

describe('refcounting: the pair nests, the C mask sees one edge', () => {
	it('counts host depth and drives the C mask only on the outer edges', () => {
		const vm = fakeVm();
		const m = newMask({ vm });
		expect(m.enter()).toBe(1);
		expect(m.enter()).toBe(2);
		expect(m.exit()).toBe(1);
		expect(m.exit()).toBe(0);
		expect(m.depth()).toBe(0);
		// the C mask saw exactly one on/off pair
		expect(vm.state.maskCalls).toEqual([1, 0]);
		expect(vm.state.depth).toBe(0);

		const s = m.stats();
		expect(s.enters).toBe(2);
		expect(s.nested).toBe(1);
		expect(s.maxDepth).toBe(2);
	});

	it('nests three deep on the real case: a host call whose body triggers a lazy-FS read', () => {
		const vm = fakeVm();
		const m = newMask({ vm });
		const seen: number[] = [];
		m.withMask(() => {
			seen.push(m.depth());
			m.withMask(() => {
				seen.push(m.depth());
				m.withMask(() => seen.push(m.depth()));
			});
			seen.push(m.depth());
		});
		expect(seen).toEqual([1, 2, 3, 1]);
		expect(m.depth()).toBe(0);
		expect(vm.state.maskCalls).toHaveLength(2);
	});
});

describe('the pending flag: a masked interrupt is not lost', () => {
	it('detects the deferral on unmask and pushes it into the VM', () => {
		const vm = fakeVm();
		const m = newMask({ vm });
		m.enter();
		vm.tick(); // fires with the mask on, so C sets no flag
		expect(vm.state.flaggedByTick).toBe(0);
		expect(m.pending()).toBe(false);
		m.exit();
		expect(m.stats().deferred).toBe(1);
		expect(vm.state.raises).toBe(1);
		expect(m.pending()).toBe(false);
		// the raise was never attempted while masked, which the C guard would refuse
		expect(vm.state.refused).toBe(0);
	});

	it('leaves the flag for the poll site when the binary has no raise export', () => {
		const vm = fakeVm({ raise: false });
		const m = newMask({ vm });
		m.withMask(() => vm.tick());
		expect(m.pending()).toBe(true);
		expect(m.takePending()).toBe(true);
		expect(m.takePending()).toBe(false);
		expect(m.stats().consumed).toBe(1);
	});

	it('keeps the flag set when the C guard declines the raise', () => {
		const vm = fakeVm({ raise: 'refuse' });
		const m = newMask({ vm });
		m.withMask(() => vm.tick());
		expect(m.pending()).toBe(true);
		expect(vm.state.refused).toBe(1);
		expect(vm.state.raises).toBe(0);
	});

	it('collapses two fires at three levels into one boundary', () => {
		const vm = fakeVm();
		const m = newMask({ vm });
		m.withMask(() => {
			vm.tick();
			m.withMask(() => {
				vm.tick();
				m.withMask(() => {});
			});
		});
		// one boundary, not one per level and not one per fire
		expect(vm.state.raises).toBe(1);
		expect(m.stats().deferred).toBe(1);
		expect(m.stats().raised).toBe(1);
	});

	it('leaves an untouched window alone, and an unmasked fire to C', () => {
		const vm = fakeVm();
		const m = newMask({ vm });
		m.withMask(() => {});
		expect(vm.state.raises).toBe(0);
		expect(m.pending()).toBe(false);
		// a tick outside any mask is C's business, not the host's
		vm.tick();
		expect(vm.state.flaggedByTick).toBe(1);
		expect(m.pending()).toBe(false);
	});

	it('still masks on a binary with no stat export, where no delta is readable', () => {
		const vm = fakeVm();
		vm.stat = null;
		const m = newMask({ vm });
		m.withMask(() => vm.tick());
		expect(m.stats().deferred).toBe(0);
		expect(vm.state.maskCalls).toHaveLength(2);
		// explicit raise still works, which is what a driver-side budget stop uses
		expect(m.raise()).toBe(true);
		expect(vm.state.raises).toBe(1);
	});
});

describe('the budget is re-checked on unmask, not only at the poll site', () => {
	it('checks once per outermost unmask, after the C mask is released', () => {
		const vm = fakeVm();
		let calls = 0;
		let sawCMask: number | null = null;
		const m = newMask({
			vm,
			budgetExceeded: () => {
				calls++;
				sawCMask = vm.state.depth;
				return true;
			}
		});
		m.withMask(() => {
			m.withMask(() => {
				m.withMask(() => {});
			});
		});
		expect(calls).toBe(1);
		// an overrun defers a boundary with no fire at all
		expect(m.stats().budgetDeferred).toBe(1);
		expect(vm.state.raises).toBe(1);
		// the C raise refuses while its own mask is nonzero, so the order matters
		expect(sawCMask).toBe(0);
		expect(m.stats().deferred).toBe(0);
	});

	it('raises nothing for an in-budget window, but still runs the check', () => {
		const vm = fakeVm();
		const m = newMask({ vm, budgetExceeded: () => false });
		m.withMask(() => {});
		expect(vm.state.raises).toBe(0);
		expect(m.stats().budgetChecks).toBe(1);
	});

	it('honours the budget with no VM bound, which is the shipping non-JSPI build', () => {
		// the driver has to see the overrun rather than a silent overshoot
		const m = newMask({ budgetExceeded: () => true });
		m.withMask(() => {});
		expect(m.pending()).toBe(true);
		expect(m.stats().budgetDeferred).toBe(1);
		expect(m.takePending()).toBe(true);
	});

	it('treats a fire plus an overrun as one boundary with two causes', () => {
		const vm = fakeVm();
		const m = newMask({ vm, budgetExceeded: () => true });
		m.withMask(() => vm.tick());
		expect(vm.state.raises).toBe(1);
		expect(m.stats().deferred + m.stats().budgetDeferred).toBe(2);
	});
});

describe('the dev assertion: suspension never above depth 0', () => {
	it('throws on host depth and names the site and the depth', () => {
		const vm = fakeVm();
		const m = newMask({ vm });
		expect(m.assertSuspendable()).toBe(true);
		m.enter();
		const e = thrown(() => m.assertSuspendable('cfwVmYield'));
		expect(e).toBeInstanceOf(MaskViolationError);
		expect((e as Error).message).toContain('cfwVmYield');
		expect((e as Error).message).toContain('depth 1');
		expect(m.stats().violations).toBe(1);
		m.exit();
		expect(m.assertSuspendable()).toBe(true);
	});

	// the control, and the trap: the C handler masks itself for the duration of its own
	// yield, so stat(4) reads 1 at exactly the moment suspension is legal; asserting on the
	// C mask instead of the host depth would trip on every single slice.
	it('does NOT trip on the C mask, which reads 1 inside the handler', () => {
		const vm = fakeVm();
		const m = newMask({ vm });
		vm.mask(1);
		expect(vm.stat?.(SLICE_STAT_MASK)).toBe(1);
		expect(m.assertSuspendable()).toBe(true);
		expect(m.stats().violations).toBe(0);
		vm.mask(0);
	});

	it('is fail-safe in prod: returns false rather than throwing into a render', () => {
		const m = newMask({ vm: fakeVm(), dev: false });
		m.enter();
		expect(m.assertSuspendable()).toBe(false);
		expect(m.stats().violations).toBe(1);
		m.exit();
	});

	it('throws on an unbalanced exit in dev without going negative', () => {
		const m = newMask({ vm: fakeVm() });
		expect(thrown(() => m.exit())).toBeInstanceOf(MaskViolationError);
		expect(m.depth()).toBe(0);
	});

	it('returns 0 from an unbalanced exit in prod and touches no C mask', () => {
		const vm = fakeVm();
		const m = newMask({ vm, dev: false });
		expect(m.exit()).toBe(0);
		expect(vm.state.maskCalls).toHaveLength(0);
		expect(m.stats().violations).toBe(1);
	});
});

describe('withMask: the default path, and it unmasks on a throw', () => {
	it('returns the body value and balances the pair across a throw', () => {
		const vm = fakeVm();
		const m = newMask({ vm });
		expect(m.withMask(() => 42)).toBe(42);
		expect(m.depth()).toBe(0);

		const boom = new Error('bridge blew up');
		expect(
			thrown(() =>
				m.withMask(() => {
					throw boom;
				})
			)
		).toBe(boom);
		expect(m.depth()).toBe(0);
		expect(vm.state.depth).toBe(0);
		expect(vm.state.maskCalls).toEqual([1, 0, 1, 0]);
	});

	it('still defers the boundary when the body throws', () => {
		// an error path that ate the deferral would lose a slice boundary silently
		const vm = fakeVm();
		const m = newMask({ vm });
		thrown(() =>
			m.withMask(() => {
				vm.tick();
				throw new Error('nope');
			})
		);
		expect(vm.state.raises).toBe(1);
		expect(m.depth()).toBe(0);
	});

	it('refuses a thenable body in dev, and unmasks anyway', () => {
		const vm = fakeVm();
		const m = newMask({ vm });
		expect(
			thrown(() => {
				m.withMask(() => Promise.resolve(1));
			})
		).toBeInstanceOf(MaskViolationError);
		expect(m.depth()).toBe(0);
		expect(vm.state.depth).toBe(0);
	});

	it('passes a thenable through in prod, where the mask just cannot span the await', () => {
		const vm = fakeVm();
		const m = newMask({ vm, dev: false });
		const out = m.withMask(() => Promise.resolve(7));
		expect(typeof out?.then).toBe('function');
		expect(m.depth()).toBe(0);
	});
});

describe('vmFromBinary: the seam onto the patched binary', () => {
	/** the export table an emscripten Module exposes once the interrupt patch is applied */
	type PatchedBinary = {
		_zend_wasm_slice_mask?: (on: number) => number;
		_zend_wasm_slice_stat?: (which: number) => number;
		_zend_wasm_slice_raise?: () => number;
	};

	const patched = (calls: unknown[][] = []): PatchedBinary => ({
		_zend_wasm_slice_mask: (on) => {
			calls.push(['mask', on]);
			return on;
		},
		_zend_wasm_slice_stat: (which) => {
			calls.push(['stat', which]);
			return which === SLICE_STAT_FIRES ? 11 : 0;
		}
	});

	it.each([
		{ what: 'a binary with no patch', binary: {} as PatchedBinary | undefined },
		{ what: 'no binary at all', binary: undefined }
	])('is null for $what, which is every non-JSPI build', ({ binary }) => {
		expect(vmFromBinary(binary)).toBe(null);
	});

	it('builds from the mask export, and reports no raise export', () => {
		const vm = vmFromBinary(patched());
		expect(vm).toBeTruthy();
		expect(vm?.raise).toBe(null);
	});

	it.each([
		{ on: true, want: 1 },
		{ on: false, want: 0 }
	])('coerces mask($on) to the C int $want', ({ on, want }) => {
		const calls: unknown[][] = [];
		const vm = vmFromBinary(patched(calls));
		vm?.mask(on);
		expect(calls[0]).toEqual(['mask', want]);
	});

	it('passes the stat index through', () => {
		const vm = vmFromBinary(patched());
		expect(vm?.stat?.(SLICE_STAT_FIRES)).toBe(11);
	});

	it('picks up the raise export when it exists, and booleanises its int return', () => {
		const binary = patched();
		binary._zend_wasm_slice_raise = () => 1;
		const withRaise = vmFromBinary(binary);
		expect(withRaise?.raise).toBeTruthy();
		expect(withRaise?.raise?.()).toBe(true);
	});

	it('reports a missing stat export as null rather than throwing', () => {
		expect(vmFromBinary({ _zend_wasm_slice_mask: () => 0 })?.stat).toBe(null);
	});
});

// the SQL-bridge half of this describe asserts on `SiteDurableObject.prototype.installBridge`,
// which left with the durabledb split; it now runs there, folded into
// durabledb/tests/do-sqlite.spec.ts with its assertions unchanged
describe('the singleton surface the call sites import', () => {
	beforeEach(() => resetMask());
	afterEach(() => {
		configureMask({ vm: null, budgetExceeded: null });
		resetMask();
	});

	it('has a working default surface with no configuration at all', () => {
		// the singleton is what the call sites import, and the shipping non-JSPI build
		// configures nothing
		expect(maskEnter()).toBe(1);
		expect(maskExit()).toBe(0);
		expect(pendingInterrupt()).toBe(false);
		expect(takePendingInterrupt()).toBe(false);
		expect(maskStats().hasVm).toBe(false);
	});
});

describe('the wiring: the lazy node read path in src/runtime/lazy-fs.js', () => {
	// mountDrupalLazy() needs a real emscripten FS and env.ASSETS, so the bracket is asserted
	// on the source. The behaviour it produces is covered above; what is checked here is that
	// the call site actually has the shape.

	it('imports the mask pair', () => {
		// quote- AND extension-agnostic: this hardcoded double quotes and broke when prettier
		// switched to single, then hardcoded `.js` and broke when organize-imports normalised
		// the specifier. Both times the wiring was fine and the assertion was wrong
		expect(
			/import \{\s*maskEnter,\s*maskExit\s*\} from ['"]\.\/mask(\.js)?['"]/.test(lazyFsSource)
		).toBe(true);
	});

	it('wraps materialise() so the inflate is inside the mask and the exit is in a finally', () => {
		const start = lazyFsSource.indexOf('function materialise(node');
		const end = lazyFsSource.indexOf('const dirs = new Set');
		expect(start > 0 && end > start).toBe(true);

		const body = lazyFsSource.slice(start, end);
		const enterAt = body.indexOf('maskEnter();');
		const inflateAt = body.indexOf('inflateSync(');
		const finallyAt = body.indexOf('} finally {');
		const exitAt = body.indexOf('maskExit();');
		expect(enterAt > 0 && enterAt < inflateAt).toBe(true);
		expect(inflateAt > enterAt && inflateAt < finallyAt).toBe(true);
		expect(finallyAt > inflateAt && exitAt > finallyAt).toBe(true);
		expect(body.split('maskEnter();').length - 1).toBe(1);
		expect(body.split('maskExit();').length - 1).toBe(1);
	});
});

describe('the composition: a boot-shaped sequence of masked windows', () => {
	it('accounts for every fire across many reads, one nested call and one overrun', () => {
		// what boot actually looks like: many lazy reads, one of which nests a host call,
		// with the interrupt counter landing wherever it lands
		const vm = fakeVm();
		let overrun = false;
		const m = newMask({ vm, budgetExceeded: () => overrun });
		const inflate = (fireInside: boolean) =>
			m.withMask(() => {
				if (fireInside) vm.tick();
			});

		inflate(false);
		inflate(true); // a fire during a cold read
		vm.tick(); // a fire between reads, which C handles on its own
		inflate(false);
		m.withMask(() => {
			// a host call whose body triggers a lazy read, the real nesting case
			inflate(true);
			vm.tick();
		});
		overrun = true;
		inflate(false); // in budget terms this one overruns

		expect(vm.state.fires).toBe(4);
		expect(vm.state.flaggedByTick).toBe(1);
		expect(m.stats().deferred).toBe(2);
		expect(m.stats().budgetDeferred).toBe(1);
		expect(vm.state.raises).toBe(3);
		expect(vm.state.refused).toBe(0);
		expect(m.pending()).toBe(false);
		expect(m.depth()).toBe(0);
		expect(vm.state.depth).toBe(0);
		expect(m.stats().nested).toBe(1);
	});
});
