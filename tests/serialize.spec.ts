import { describe, expect, it } from 'vitest';
import { Gate, doGate } from '../src/serialize.js';

/**
 * First ported suite; it establishes the pattern for the other nine.
 *
 * It replaces `scripts/test-serialize.mjs` (14 hand-rolled assertions) and runs INSIDE
 * workerd through `@cloudflare/vitest-pool-workers`, which is the whole reason to move:
 * the hand-rolled suites run in Node, and this project's subject is behaviour that only
 * exists in workerd. See `test/README.md` for what each remaining suite needs.
 *
 * What carried over unchanged, because it is why the original could not go flaky:
 * every assertion is on observed concurrency or on shared-state corruption, never on
 * timing. `maxConcurrent` above 1 is a serialization failure by definition, so the test
 * does not have to guess how slow the machine is.
 */

/** resolves after `n` macrotask turns, so interleaving is possible but never timed */
const turns = async (n: number) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Gate', () => {
	it('serializes callbacks so at most one runs at a time', async () => {
		const gate = new Gate();
		let inside = 0;
		let maxInside = 0;

		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				gate.run(async () => {
					inside++;
					maxInside = Math.max(maxInside, inside);
					await turns(2);
					inside--;
					return i;
				})
			)
		);

		expect(maxInside).toBe(1);
		expect(gate.stats().maxConcurrent).toBe(1);
		expect(gate.stats().active).toBe(0);
		expect(gate.stats().completed).toBe(8);
	});

	it('runs callbacks in submission order', async () => {
		const gate = new Gate();
		const order: number[] = [];
		await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				gate.run(async () => {
					await turns(1);
					order.push(i);
				})
			)
		);
		expect(order).toEqual([0, 1, 2, 3, 4]);
	});

	it('returns each callback its own value', async () => {
		const gate = new Gate();
		const values = await Promise.all([
			gate.run(() => 'a'),
			gate.run(() => 'b'),
			gate.run(() => 'c')
		]);
		expect(values).toEqual(['a', 'b', 'c']);
	});

	it('does not wedge the chain when a callback rejects', async () => {
		const gate = new Gate();
		const failed = gate.run(() => {
			throw new Error('boom');
		});
		await expect(failed).rejects.toThrow('boom');

		// the whole point: the next entrant still runs. A rejecting predecessor that held
		// the link would deadlock every later caller, which is exactly how a nested acquire
		// of this gate hung every request in the Durable Object once
		await expect(gate.run(() => 'after')).resolves.toBe('after');
		expect(gate.stats().active).toBe(0);
	});

	it('gives a rejection only to its own caller', async () => {
		const gate = new Gate();
		const bad = gate.run(() => Promise.reject(new Error('mine')));
		const good = gate.run(() => 'unaffected');
		await expect(bad).rejects.toThrow('mine');
		await expect(good).resolves.toBe('unaffected');
	});

	it('records completion order by label', async () => {
		const gate = new Gate();
		await gate.run(() => 1, 'first');
		await gate.run(() => 2, 'second');
		expect(gate.stats().order).toEqual(['first', 'second']);
	});

	it('drain() resolves once everything submitted has settled', async () => {
		const gate = new Gate();
		let done = 0;
		for (let i = 0; i < 4; i++) {
			void gate.run(async () => {
				await turns(1);
				done++;
			});
		}
		await gate.drain();
		expect(done).toBe(4);
	});

	it('drain() is unaffected by a rejection', async () => {
		const gate = new Gate();
		void gate.run(() => Promise.reject(new Error('x'))).catch(() => {});
		void gate.run(() => 'ok');
		await expect(gate.drain()).resolves.toBeUndefined();
	});

	it('protects shared mutable state a non-atomic read-modify-write would corrupt', async () => {
		const gate = new Gate();
		const shared = { value: 0 };
		await Promise.all(
			Array.from({ length: 20 }, () =>
				gate.run(async () => {
					const seen = shared.value;
					await turns(1);
					shared.value = seen + 1;
				})
			)
		);
		// without the gate every callback reads the same value and this lands well under 20
		expect(shared.value).toBe(20);
	});

	it('reports queue depth while entrants are waiting', async () => {
		const gate = new Gate();
		let release: (() => void) | undefined;
		const held = gate.run(() => new Promise<void>((r) => (release = r)));
		const waiting = [gate.run(() => 1), gate.run(() => 2)];
		// the first task starts a microtask after submission, so let the chain settle before
		// reading: otherwise queued reads 3 and active reads 0
		await turns(1);
		expect(gate.stats().queued).toBe(2);
		expect(gate.stats().active).toBe(1);
		release?.();
		await Promise.all([held, ...waiting]);
		expect(gate.stats().queued).toBe(0);
	});
});

describe('doGate', () => {
	it('routes through blockConcurrencyWhile when a ctx provides it', async () => {
		const gate = new Gate();
		const calls: string[] = [];
		const ctx = {
			blockConcurrencyWhile: async <T>(fn: () => Promise<T> | T): Promise<T> => {
				calls.push('blocked');
				return fn();
			}
		};
		const gated = doGate(gate, ctx);
		await expect(gated.run(() => 'value')).resolves.toBe('value');
		expect(calls).toEqual(['blocked']);
	});

	it('falls back to the plain gate when ctx cannot suppress events', async () => {
		const gate = new Gate();
		const gated = doGate(gate, {});
		await expect(gated.run(() => 'value')).resolves.toBe('value');
		expect(gate.stats().completed).toBe(1);
	});

	it('still serializes when it falls back', async () => {
		const gate = new Gate();
		const gated = doGate(gate, {});
		let inside = 0;
		let maxInside = 0;
		await Promise.all(
			Array.from({ length: 6 }, () =>
				gated.run(async () => {
					inside++;
					maxInside = Math.max(maxInside, inside);
					await turns(1);
					inside--;
				})
			)
		);
		expect(maxInside).toBe(1);
	});

	it('delegates stats() and drain() to the gate it wraps', async () => {
		// two one-line wrappers, and the reason they are tested rather than assumed is that they are
		// the whole reason `doGate` returns a GateLike instead of the Gate itself: a consumer holding
		// the wrapper has to be able to read the same counters and await the same tail
		const gate = new Gate();
		const gated = doGate(gate, {});
		await gated.run(() => 'a', 'labelled');
		expect(gated.stats()).toEqual(gate.stats());
		expect(gated.stats().order).toEqual(['labelled']);
		let settled = false;
		void gated.run(async () => {
			await turns(2);
			settled = true;
		});
		await gated.drain();
		expect(settled).toBe(true);
	});
});
