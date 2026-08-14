/**
 * Shim for the ENVIRONMENT=worker emscripten build.
 *
 * That build sets ENVIRONMENT_IS_WORKER=true and reads `self.location.href` at
 * module scope to derive scriptDirectory. workerd has `self`, but no
 * `self.location`, so it throws before instantiation.
 *
 * Only the href is ever used, and only to resolve the .wasm URL -- which we
 * override via instantiateWasm anyway, so any well-formed URL works.
 *
 * This is much smaller than the browser build's shim: no document, no window,
 * no screen. It is the reason worker-mjs is the right target for workerd.
 *
 * Import this FIRST so it evaluates ahead of the glue.
 */

/** the emscripten glue's own view of the globals it patches */
interface ShimGlobals {
	location?: unknown;
	Asyncify?: { handleAsync(fn?: unknown): number; __cfwStub?: boolean };
	__cfwAsyncifyCalls?: number;
}

const g = globalThis as unknown as ShimGlobals;

if (typeof g.location === 'undefined') {
	g.location = new URL('https://drupal-cfw.invalid/worker.mjs');
}

/**
 * Stubs the `Asyncify` object the glue references but ASYNCIFY=0 compiled out.
 *
 * THE BUG THIS CLOSES, and it is a denial-of-service surface rather than a nuisance.
 * The glue contains two `Asyncify.handleAsync(...)` call sites --
 * `__asyncjs__php_stream_fetch_real_open` (the http/https stream wrapper) and
 * `__asyncjs__vrzno_await_internal` -- and declares `Asyncify` nowhere, so it is a
 * free identifier that resolves here. Reaching either one threw
 * `ReferenceError: Asyncify is not defined`.
 *
 * That throw originates in JS, so it escapes the wasm import and **PHP cannot catch
 * it at all**: measured twice, from two unrelated routes, with `@` and
 * `catch (\Throwable)` both useless and the whole invocation dying. And
 * `stream_get_wrappers()` advertises http/https, so ordinary contrib and vendor code
 * will legitimately reach for them -- an uncatchable request kill reachable by
 * installing a normal module.
 *
 * A synchronous stub cannot await, which is the entire point of Asyncify, so it does
 * not try. It returns the failure sentinel the call sites' C callers already
 * understand, so a stream open fails and `fopen()` returns false, which PHP code
 * handles. "Returns false" is a contract; "the invocation vanishes" is not.
 *
 * Calls are counted on `globalThis.__cfwAsyncifyCalls` because this failure is
 * invisible to every PHP-side instrument -- no PHP fatal, no printErr, and Drupal's
 * logger never runs -- so the only place it can be observed is here.
 */
if (typeof g.Asyncify === 'undefined') {
	g.__cfwAsyncifyCalls = 0;
	g.Asyncify = {
		handleAsync(): number {
			g.__cfwAsyncifyCalls = (g.__cfwAsyncifyCalls ?? 0) + 1;
			// -1, not 0: returning 0 was measured to be taken as a VALID stream handle,
			// after which the C side asked target 0 for its status and the glue threw
			// "Cannot read properties of undefined (reading 'status')" -- a different
			// uncatchable throw, one layer further in
			return -1;
		},
		// present so a future ASYNCIFY=1 build cannot silently pick up this stub
		__cfwStub: true
	};
}

export {};
