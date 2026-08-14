import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The shim, which is the one module in this package with a side effect.
 *
 * IT HAS TO BE IMPORTED FOR ITS EFFECT, before the emscripten glue evaluates, so the spec imports it
 * the same way a consumer does -- `import '../src/worker-shim.js'` -- rather than pulling named
 * exports out of it. That is also why `package.json` lists it in `sideEffects` instead of declaring
 * the package side-effect-free: a bundler that tree-shook this file away would delete the fix and
 * leave the failure it closes.
 *
 * WHAT IT CLOSES IS A DENIAL-OF-SERVICE SURFACE, not a nuisance. The php-wasm glue contains two
 * `Asyncify.handleAsync(...)` call sites and declares `Asyncify` nowhere, so it is a free identifier
 * that `ASYNCIFY=0` compiled out. Reaching either one threw `ReferenceError: Asyncify is not
 * defined` from inside a wasm import, which PHP cannot catch at all -- measured twice, from two
 * unrelated routes, with `@` and `catch (\Throwable)` both useless and the whole invocation dying.
 * `stream_get_wrappers()` advertises http and https, so ordinary contrib code reaches for them.
 */

/** the two globals the shim owns, as it declares them */
interface ShimGlobals {
	location?: unknown;
	Asyncify?: { handleAsync(fn?: unknown): number; __cfwStub?: boolean };
	__cfwAsyncifyCalls?: number;
}

const g = globalThis as unknown as ShimGlobals;

describe('worker-shim', () => {
	beforeAll(async () => {
		await import('../src/worker-shim.js');
	});

	it('leaves a well-formed location in place', () => {
		// the emscripten ENVIRONMENT=worker build reads self.location.href at module scope to derive
		// scriptDirectory, and workerd has `self` but no `self.location`, so it throws before
		// instantiation. Only the href is ever used, and only to resolve the .wasm URL
		expect(typeof g.location).not.toBe('undefined');
		expect(String((g.location as { href?: string })?.href ?? g.location)).toContain('://');
	});

	it('installs an Asyncify object where the glue expects a free identifier', () => {
		expect(g.Asyncify).toBeDefined();
		expect(typeof g.Asyncify?.handleAsync).toBe('function');
	});

	it('marks itself, so a future ASYNCIFY=1 build cannot silently pick up the stub', () => {
		expect(g.Asyncify?.__cfwStub).toBe(true);
	});

	it('returns -1, NOT 0, because 0 was measured to be taken as a valid stream handle', () => {
		// with 0 the C side asked target 0 for its status and the glue threw "Cannot read properties
		// of undefined (reading 'status')" -- the same class of uncatchable throw, one layer further in
		expect(g.Asyncify?.handleAsync(() => undefined)).toBe(-1);
	});

	it('counts every call on globalThis, the only place this failure is observable', () => {
		// no PHP fatal, no printErr, and Drupal's logger never runs, so a PHP-side handler cannot see
		// it; the counter is what a tripwire and a /serve-stats route both read
		const before = g.__cfwAsyncifyCalls ?? 0;
		g.Asyncify?.handleAsync();
		g.Asyncify?.handleAsync();
		expect(g.__cfwAsyncifyCalls).toBe(before + 2);
	});

	it('is idempotent, so importing it twice does not reset the counter', async () => {
		const before = g.__cfwAsyncifyCalls ?? 0;
		await import('../src/worker-shim.js');
		expect(g.__cfwAsyncifyCalls).toBe(before);
		expect(g.Asyncify?.__cfwStub).toBe(true);
	});

	it('is synchronous by construction: handleAsync returns a number, never a promise', () => {
		// a synchronous stub CANNOT await, which is the entire point of Asyncify, so it does not try.
		// "returns a failure sentinel" is a contract; "the invocation vanishes" is not
		const answer = g.Asyncify?.handleAsync(async () => 1);
		expect(typeof answer).toBe('number');
		expect(answer).not.toBeInstanceOf(Promise);
	});
});
