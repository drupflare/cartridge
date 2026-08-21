import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SCRIPT_DIR,
	DEFAULT_SCRIPT_NAME,
	_entryPointProblem,
	_makeRunResult,
	createCartridge,
	type Interpreter,
	type InterpreterIo
} from '../src/cartridge.js';
import { CartridgeError, GateError, InterpreterError } from '../src/errors.js';
import { createMask } from '../src/mask.js';
import { Gate } from '../src/serialize.js';
import { fromUtf8, toUtf8 } from '../src/util.js';

/**
 * `createCartridge()`, driven over a fake interpreter.
 *
 * A fake interpreter is the right instrument here, and it is worth saying why rather than treating it
 * as a compromise. What this file is testing is the WIRING -- that every entry is serialised, that a
 * host callback runs masked, that the script lands in the filesystem before `callMain` is entered,
 * that the mask is back to depth 0 afterwards. None of that is a property of any particular wasm
 * build, and a real build would make the assertions depend on a 40 MB binary that exists on one
 * machine. The fake exposes the same `{ FS, callMain }` shape the real one does, so what passes here
 * is the contract, not an approximation of it.
 *
 * What it deliberately does NOT prove: that any real emscripten module actually exports `callMain`
 * and `FS`. That is a build-flag question, answered in ADVANCED_USAGE.md and by the consumer.
 */

/** what the fake interpreter recorded */
interface FakeState {
	calls: string[][];
	written: Map<string, string>;
	dirs: string[];
	instantiations: number;
	maskDepthInsidePrint: number[];
	maskDepthInsideMain: number[];
}

interface FakeOptions {
	/** what `main` does with the io it was given */
	main?: (argv: string[], io: InterpreterIo, state: FakeState) => number | void;
	/** throw from instantiate instead of returning a module */
	failInstantiate?: string;
	/** return something that is not an interpreter */
	returnGarbage?: 'null' | 'noCallMain' | 'noFs';
	/** resolve instantiate only after this many microtask turns, to widen the boot race */
	bootDelay?: number;
}

function fake(options: FakeOptions = {}) {
	const state: FakeState = {
		calls: [],
		written: new Map(),
		dirs: [],
		instantiations: 0,
		maskDepthInsidePrint: [],
		maskDepthInsideMain: []
	};

	const instantiate = async (io: InterpreterIo): Promise<Interpreter> => {
		state.instantiations++;
		for (let i = 0; i < (options.bootDelay ?? 0); i++) await Promise.resolve();
		if (options.failInstantiate !== undefined) throw new Error(options.failInstantiate);
		if (options.returnGarbage === 'null') return null as unknown as Interpreter;
		if (options.returnGarbage === 'noCallMain') {
			return { FS: {} } as unknown as Interpreter;
		}
		if (options.returnGarbage === 'noFs') {
			return { callMain: () => 0 } as unknown as Interpreter;
		}
		return {
			FS: {
				mkdir(path: string): void {
					if (state.dirs.includes(path)) throw new Error('EEXIST');
					state.dirs.push(path);
				},
				writeFile(path: string, data: Uint8Array | string): void {
					state.written.set(path, typeof data === 'string' ? data : toUtf8(data));
				},
				utime(): void {}
			},
			callMain(argv: string[]): number | void {
				state.calls.push(argv);
				const run = options.main ?? ((_argv, out) => void out.print('ok'));
				return run(argv, io, state);
			}
		};
	};

	return { state, instantiate };
}

describe('createCartridge: the happy path a first-timer gets', () => {
	it('writes the script, runs it, and hands back decoded stdout', async () => {
		const { state, instantiate } = fake({
			main: (argv, io) => {
				io.print('line one');
				io.print('line two');
			}
		});
		const cartridge = createCartridge({ instantiate });

		const result = await cartridge.run('print("hi")');

		expect(state.written.get('/cartridge/main')).toBe('print("hi")');
		expect(state.calls).toEqual([['/cartridge/main']]);
		expect(result.stdoutText).toBe('line one\nline two\n');
		expect(result.status).toBe(0);
		expect(result.path).toBe('/cartridge/main');
	});

	it('takes bytes as readily as a string, so no caller builds an encoder', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		await cartridge.run(fromUtf8('bytes in'));
		expect(state.written.get('/cartridge/main')).toBe('bytes in');
	});

	it('does not instantiate until something needs the interpreter', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		expect(state.instantiations).toBe(0);
		expect(cartridge.stats().booted).toBe(false);
		await cartridge.run('x');
		expect(state.instantiations).toBe(1);
		expect(cartridge.stats().booted).toBe(true);
	});

	it('instantiates exactly once across many runs', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		await cartridge.run('a');
		await cartridge.run('b');
		await cartridge.run('c');
		expect(state.instantiations).toBe(1);
		expect(cartridge.stats().runs).toBe(3);
	});

	it('instantiates once even when several runs race the boot', async () => {
		// bootDelay widens the window: without the in-flight promise being shared, each of the three
		// would start its own instantiate
		const { state, instantiate } = fake({ bootDelay: 3 });
		const cartridge = createCartridge({ instantiate });
		await Promise.all([cartridge.run('a'), cartridge.run('b'), cartridge.run('c')]);
		expect(state.instantiations).toBe(1);
	});

	it('mounts the boot files under the script directory', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({
			instantiate,
			files: { 'lib/helper.txt': 'shared', '/etc/absolute': 'kept' }
		});
		await cartridge.run('x');
		expect(state.written.get('/cartridge/lib/helper.txt')).toBe('shared');
		expect(state.written.get('/etc/absolute')).toBe('kept');
	});

	it('creates the script directory on boot, before any write', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate, scriptDir: '/deep/scripts' });
		await cartridge.run('x');
		expect(state.dirs).toContain('/deep/scripts');
		expect(state.written.has('/deep/scripts/main')).toBe(true);
	});

	it('honours scriptDir, scriptName and a custom argv builder', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({
			instantiate,
			scriptDir: '/app/',
			scriptName: 'entry.php',
			argv: (path) => ['-f', path, '--', 'extra']
		});
		const result = await cartridge.run('x');
		expect(result.path).toBe('/app/entry.php');
		expect(state.calls).toEqual([['-f', '/app/entry.php', '--', 'extra']]);
	});

	it('exposes the defaults it uses, rather than hiding them in a string literal', () => {
		expect(DEFAULT_SCRIPT_DIR).toBe('/cartridge');
		expect(DEFAULT_SCRIPT_NAME).toBe('main');
	});
});

describe('createCartridge: serialisation', () => {
	it('never lets two runs into the interpreter at once', async () => {
		let inside = 0;
		let peak = 0;
		const { instantiate } = fake({
			main: () => {
				inside++;
				if (inside > peak) peak = inside;
				inside--;
			}
		});
		const cartridge = createCartridge({ instantiate });
		await Promise.all(Array.from({ length: 8 }, (_, i) => cartridge.run(`s${i}`)));
		expect(peak).toBe(1);
		expect(cartridge.stats().gate.maxConcurrent).toBe(1);
		expect(() => cartridge.assertSerialised()).not.toThrow();
	});

	it('runs in submission order, which is what makes a script sequence reproducible', async () => {
		const { instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		await Promise.all(['a', 'b', 'c'].map((s) => cartridge.run(s)));
		expect(cartridge.stats().gate.order).toEqual([
			'run /cartridge/main',
			'run /cartridge/main',
			'run /cartridge/main'
		]);
	});

	it('does not wedge the queue when one run throws', async () => {
		let call = 0;
		const { instantiate } = fake({
			main: (_argv, io) => {
				call++;
				if (call === 1) throw new Error('first run exploded');
				io.print('second survived');
			}
		});
		const cartridge = createCartridge({ instantiate });
		const first = cartridge.run('a');
		const second = cartridge.run('b');
		await expect(first).rejects.toThrow(InterpreterError);
		expect((await second).stdoutText).toBe('second survived\n');
	});

	it('shares a caller-supplied gate, so a consumer can gate more than the interpreter', async () => {
		const gate = new Gate();
		const { instantiate } = fake();
		const cartridge = createCartridge({ instantiate, gate });
		await cartridge.run('x');
		await gate.run(async () => undefined, 'the consumer’s own work');
		expect(gate.stats().completed).toBe(2);
		expect(gate.stats().maxConcurrent).toBe(1);
	});

	it('takes the Durable Object flavour when a ctx is given', async () => {
		const blocked: number[] = [];
		const ctx = {
			blockConcurrencyWhile: async <T>(fn: () => Promise<T> | T): Promise<T> => {
				blocked.push(1);
				return fn();
			}
		};
		const { instantiate } = fake();
		const cartridge = createCartridge({ instantiate, ctx });
		await cartridge.run('x');
		// one block per gated entry, taken INSIDE the gate: blockConcurrencyWhile cannot nest
		expect(blocked.length).toBe(1);
	});

	it('assertSerialised throws GateError if the gate ever saw two at once', async () => {
		// the gate cannot be made to fail from outside, so this drives the assertion over a stub whose
		// stats report the failure the real gate is there to prevent
		const gate = new Gate();
		Object.defineProperty(gate, 'stats', {
			value: () => ({ maxConcurrent: 2, active: 0, queued: 0, completed: 2, order: [] })
		});
		const { instantiate } = fake();
		const cartridge = createCartridge({ instantiate, gate });
		try {
			cartridge.assertSerialised();
			expect.unreachable('two concurrent runs must be reported');
		} catch (error) {
			expect(error).toBeInstanceOf(GateError);
			expect((error as GateError).code).toBe('gate.concurrency_observed');
		}
	});
});

describe('createCartridge: the mask around host callbacks', () => {
	it('runs print and printErr masked, because they are JS frames under the interpreter', async () => {
		// the depth INSIDE the callback is what matters, and only the mask itself can see it
		const seen: number[] = [];
		const mask = createMask();
		const original = mask.withMask;
		Object.defineProperty(mask, 'withMask', {
			value: <T>(fn: () => T): T =>
				original(() => {
					seen.push(mask.depth());
					return fn();
				})
		});
		const { instantiate } = fake({
			main: (_argv, io) => {
				io.print('out');
				io.printErr('err');
			}
		});
		await createCartridge({ instantiate, mask }).run('x');
		expect(seen).toEqual([1, 1]);
	});

	it('drops back to depth 0 between callbacks, so a slice boundary can land there', async () => {
		const mask = createMask();
		const between: number[] = [];
		const { instantiate } = fake({
			main: (_argv, io) => {
				io.print('out');
				between.push(mask.depth());
				io.print('out again');
				between.push(mask.depth());
			}
		});
		await createCartridge({ instantiate, mask }).run('x');
		expect(between).toEqual([0, 0]);
	});

	it('leaves the mask at depth 0 after a run', async () => {
		const mask = createMask();
		const { instantiate } = fake({
			main: (_argv, io) => {
				io.print('a');
				io.print('b');
			}
		});
		const cartridge = createCartridge({ instantiate, mask });
		await cartridge.run('x');
		expect(mask.depth()).toBe(0);
		expect(cartridge.stats().mask.enters).toBe(2);
	});

	it('does NOT mask callMain itself, or slicing would silently stop happening', async () => {
		const mask = createMask();
		const inside: number[] = [];
		const { instantiate } = fake({
			main: () => {
				inside.push(mask.depth());
			}
		});
		await createCartridge({ instantiate, mask }).run('x');
		expect(inside).toEqual([0]);
	});

	it('reports a leaked mask depth by name rather than carrying it into the next run', async () => {
		const mask = createMask({ dev: false });
		const { instantiate } = fake({
			main: () => {
				// a host callback that entered and never exited; without the check this depth would
				// mask every later suspension forever
				mask.enter();
			}
		});
		const cartridge = createCartridge({ instantiate, mask });
		try {
			await cartridge.run('x');
			expect.unreachable('a leaked mask must be reported');
		} catch (error) {
			expect(error).toBeInstanceOf(InterpreterError);
			expect((error as InterpreterError).code).toBe('interpreter.mask_leaked');
		}
		// and it is reset, so the next run is not poisoned by the last one
		expect(mask.depth()).toBe(0);
	});

	it('defaults to a FRESH mask rather than the module singleton', async () => {
		const { instantiate } = fake({ main: (_argv, io) => void io.print('x') });
		const a = createCartridge({ instantiate });
		const b = createCartridge({ instantiate });
		await a.run('1');
		// two interpreters are two C-side counters; one shared host counter would make both wrong
		expect(a.stats().mask.enters).toBe(1);
		expect(b.stats().mask.enters).toBe(0);
	});
});

describe('createCartridge: output does not cross runs', () => {
	it('starts each run with empty stdout', async () => {
		let n = 0;
		const { instantiate } = fake({
			main: (_argv, io) => {
				n++;
				io.print(`run ${n}`);
			}
		});
		const cartridge = createCartridge({ instantiate });
		expect((await cartridge.run('a')).stdoutText).toBe('run 1\n');
		expect((await cartridge.run('b')).stdoutText).toBe('run 2\n');
	});

	it('keeps stdout and stderr apart', async () => {
		const { instantiate } = fake({
			main: (_argv, io) => {
				io.print('to out');
				io.printErr('to err');
			}
		});
		const result = await createCartridge({ instantiate }).run('x');
		expect(result.stdoutText).toBe('to out\n');
		expect(result.stderrText).toBe('to err\n');
	});

	it('answers empty rather than undefined for a silent program', async () => {
		const { instantiate } = fake({ main: () => 0 });
		const result = await createCartridge({ instantiate }).run('x');
		expect(result.stdout.length).toBe(0);
		expect(result.stdoutText).toBe('');
		expect(result.lines()).toEqual([]);
		expect(result.firstLine()).toBe('');
		expect(result.lastLine()).toBe('');
	});
});

describe('createCartridge: exit status', () => {
	it('reports the number main returned', async () => {
		const { instantiate } = fake({ main: () => 3 });
		expect((await createCartridge({ instantiate }).run('x')).status).toBe(3);
	});

	it('treats a main that returns nothing as 0', async () => {
		const { instantiate } = fake({ main: () => undefined });
		expect((await createCartridge({ instantiate }).run('x')).status).toBe(0);
	});

	it('reads the status off an emscripten ExitStatus throw rather than calling it a fault', async () => {
		const { instantiate } = fake({
			main: () => {
				// emscripten throws this shape for exit(2) with EXIT_RUNTIME off
				throw { name: 'ExitStatus', status: 2, message: 'Program terminated with exit(2)' };
			}
		});
		const result = await createCartridge({ instantiate }).run('x');
		expect(result.status).toBe(2);
	});

	it('treats any other throw as a fault, named', async () => {
		const { instantiate } = fake({
			main: () => {
				throw new Error('RuntimeError: memory access out of bounds');
			}
		});
		try {
			await createCartridge({ instantiate }).run('/x');
			expect.unreachable('a wasm trap is not an exit status');
		} catch (error) {
			expect(error).toBeInstanceOf(InterpreterError);
			expect((error as InterpreterError).code).toBe('interpreter.threw');
			expect((error as Error).message).toContain('memory access out of bounds');
		}
	});

	it('counts a faulted run, so a crash loop is visible in stats', async () => {
		const { instantiate } = fake({
			main: () => {
				throw new Error('boom');
			}
		});
		const cartridge = createCartridge({ instantiate });
		await cartridge.run('x').catch(() => undefined);
		expect(cartridge.stats().runs).toBe(1);
	});
});

describe('createCartridge: instantiate failures', () => {
	it('names an instantiate that threw', async () => {
		const { instantiate } = fake({ failInstantiate: 'no wasm codegen at request time' });
		try {
			await createCartridge({ instantiate }).run('x');
			expect.unreachable('a failed instantiate cannot run');
		} catch (error) {
			expect((error as InterpreterError).code).toBe('interpreter.instantiate_failed');
			expect((error as Error).message).toContain('no wasm codegen');
		}
	});

	it('lets a later call retry after a failed instantiate', async () => {
		let attempts = 0;
		const instantiate = async (io: InterpreterIo): Promise<Interpreter> => {
			attempts++;
			if (attempts === 1) throw new Error('transient');
			return {
				FS: { mkdir() {}, writeFile() {}, utime() {} },
				callMain: () => {
					io.print('second attempt worked');
					return 0;
				}
			};
		};
		const cartridge = createCartridge({ instantiate });
		await expect(cartridge.run('x')).rejects.toThrow(InterpreterError);
		// a stuck in-flight promise would make one bad boot permanent for the isolate's life
		expect((await cartridge.run('x')).stdoutText).toBe('second attempt worked\n');
		expect(attempts).toBe(2);
	});

	it.each(['null', 'noCallMain', 'noFs'] as const)(
		'names a module with no entry point (%s)',
		async (returnGarbage) => {
			const { instantiate } = fake({ returnGarbage });
			try {
				await createCartridge({ instantiate }).run('x');
				expect.unreachable('a module with no { FS, callMain } cannot be driven');
			} catch (error) {
				expect((error as InterpreterError).code).toBe('interpreter.no_entry_point');
				// the message has to say what to do, because this is a build-flag problem
				expect((error as Error).message).toContain('callMain');
			}
		}
	);

	it('says WHICH member is missing, because the two need different fixes', async () => {
		// measured against real builds: Pyodide has a complete FS and no callMain, wasmoon has an FS
		// without utime and no callMain, quickjs-emscripten has neither. One message for all three
		// tells a caller nothing about which of the three they are holding
		const noFs = fake({ returnGarbage: 'noFs' });
		await expect(createCartridge(noFs).run('x')).rejects.toThrow(/no FS/);
		const noCallMain = fake({ returnGarbage: 'noCallMain' });
		await expect(createCartridge(noCallMain).run('x')).rejects.toThrow(/no callMain/);
	});

	it('survives an emscripten getter that ABORTS on an unexported runtime method', async () => {
		// this is not hypothetical: wasmoon's raw module answers `typeof module.callMain` with
		// `RuntimeError: Aborted('callMain' was not exported...)`, so an unguarded read hands the
		// caller a raw wasm error out of boot() instead of this package's named one
		const instantiate = (): Interpreter =>
			({
				FS: { mkdir() {}, writeFile() {}, utime() {} },
				get callMain(): never {
					throw new WebAssembly.RuntimeError(
						"Aborted('callMain' was not exported. add it to EXPORTED_RUNTIME_METHODS)"
					);
				}
			}) as unknown as Interpreter;
		try {
			await createCartridge({ instantiate }).run('x');
			expect.unreachable('a module whose callMain getter aborts cannot be driven');
		} catch (error) {
			expect(error).toBeInstanceOf(InterpreterError);
			expect((error as InterpreterError).code).toBe('interpreter.no_entry_point');
			expect((error as Error).message).toContain('was not exported');
		}
	});

	it('names a primitive, which reaches neither member', () => {
		// `!made` misses a truthy primitive, and `made.FS` on a string is undefined rather than a
		// throw, so without this branch a string would report "no FS" and mislead
		expect(_entryPointProblem('a module' as unknown as Interpreter)).toContain('string');
		expect(_entryPointProblem(null)).toContain('null');
		expect(_entryPointProblem(undefined)).toContain('undefined');
	});

	it('passes a real { FS, callMain } through, so the guard is not vacuous', () => {
		expect(
			_entryPointProblem({ FS: { mkdir() {}, writeFile() {} }, callMain: () => 0 })
		).toBeNull();
	});
});

describe('createCartridge: the rest of the surface', () => {
	it('runFile runs a script already in the filesystem, writing nothing', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		await cartridge.write({ 'existing.py': 'print(1)' });
		const before = state.written.size;
		const result = await cartridge.runFile('/cartridge/existing.py');
		expect(state.written.size).toBe(before);
		expect(result.path).toBe('/cartridge/existing.py');
		expect(state.calls).toEqual([['/cartridge/existing.py']]);
	});

	it('write reports how many files landed', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		expect(await cartridge.write({ a: '1', b: '2' })).toBe(2);
		expect(state.written.get('/cartridge/a')).toBe('1');
		expect(cartridge.stats().filesWritten).toBe(2);
	});

	it('writeJson serialises for the caller', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		await cartridge.writeJson('/in.json', { a: [1, 2], b: null });
		expect(state.written.get('/in.json')).toBe('{"a":[1,2],"b":null}');
	});

	it('writeJson refuses an unencodable value before touching the filesystem', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		await expect(cartridge.writeJson('/in.json', cyclic)).rejects.toThrow(CartridgeError);
		expect(state.written.has('/in.json')).toBe(false);
	});

	it('per-run files are written before that run and not before others', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		await cartridge.run('x', { files: { 'once.txt': 'only for this run' } });
		expect(state.written.get('/cartridge/once.txt')).toBe('only for this run');
	});

	it('runFile takes per-run files too, so a fixture can precede a script already there', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		await cartridge.write({ 'report.py': 'print(1)' });
		await cartridge.runFile('/cartridge/report.py', { files: { 'data.json': '{"n":1}' } });
		expect(state.written.get('/cartridge/data.json')).toBe('{"n":1}');
		// runFile writes no script of its own; the two writes above are all there were
		expect(cartridge.stats().filesWritten).toBe(2);
	});

	it('a per-run path overrides the default script path', async () => {
		const { state, instantiate } = fake();
		const result = await createCartridge({ instantiate }).run('x', { path: '/tmp/other.php' });
		expect(result.path).toBe('/tmp/other.php');
		expect(state.written.has('/tmp/other.php')).toBe(true);
	});

	it('a per-run argv replaces the built one entirely', async () => {
		const { state, instantiate } = fake();
		await createCartridge({ instantiate }).run('x', { argv: ['--version'] });
		expect(state.calls).toEqual([['--version']]);
	});

	it('interpreter() is the escape hatch and it is gated', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		const raw = await cartridge.interpreter();
		expect(typeof raw.callMain).toBe('function');
		expect(state.instantiations).toBe(1);
		expect(cartridge.stats().gate.order).toEqual(['interpreter']);
	});

	it('withInterpreter runs arbitrary work inside the gate', async () => {
		const { state, instantiate } = fake();
		const cartridge = createCartridge({ instantiate });
		const answer = await cartridge.withInterpreter((raw) => {
			raw.FS.writeFile('/hand-written', 'by the caller');
			return 'done';
		}, 'custom');
		expect(answer).toBe('done');
		expect(state.written.get('/hand-written')).toBe('by the caller');
		expect(cartridge.stats().gate.order).toEqual(['custom']);
	});

	it('withInterpreter serialises against run(), which is the point of it being on here', async () => {
		let inside = 0;
		let peak = 0;
		const enter = () => {
			inside++;
			if (inside > peak) peak = inside;
		};
		const { instantiate } = fake({
			main: () => {
				enter();
				inside--;
			}
		});
		const cartridge = createCartridge({ instantiate });
		await Promise.all([
			cartridge.run('a'),
			cartridge.withInterpreter(async () => {
				enter();
				await Promise.resolve();
				inside--;
			}),
			cartridge.run('b')
		]);
		expect(peak).toBe(1);
	});
});

describe('_makeRunResult: the accessors', () => {
	const result = _makeRunResult(0, '/x', fromUtf8('one\ntwo\nthree\n'), fromUtf8('warn\n'));

	it('carries both the bytes and the decoded text', () => {
		expect(result.stdout).toEqual(fromUtf8('one\ntwo\nthree\n'));
		expect(result.stdoutText).toBe('one\ntwo\nthree\n');
		expect(result.stderrText).toBe('warn\n');
	});

	it('splits lines without a trailing empty element', () => {
		expect(result.lines()).toEqual(['one', 'two', 'three']);
	});

	it('answers first and last', () => {
		expect(result.firstLine()).toBe('one');
		expect(result.lastLine()).toBe('three');
	});

	it('indexes 0-based, and negative from the end', () => {
		expect(result.lineAt(0)).toBe('one');
		expect(result.lineAt(1)).toBe('two');
		expect(result.lineAt(-1)).toBe('three');
		expect(result.lineAt(-3)).toBe('one');
	});

	it('answers empty rather than undefined for an index that is not there', () => {
		expect(result.lineAt(99)).toBe('');
		expect(result.lineAt(-99)).toBe('');
	});

	it('parses stdout as JSON', () => {
		const json = _makeRunResult(0, '/x', fromUtf8('{"rows":[1,2]}'), new Uint8Array(0));
		expect(json.json<{ rows: number[] }>().rows).toEqual([1, 2]);
	});

	it('names the output when stdout is not JSON', () => {
		try {
			result.json();
			expect.unreachable('three lines of text are not JSON');
		} catch (error) {
			expect((error as CartridgeError).code).toBe('util.bad_json_output');
		}
	});

	it('assertOk passes a zero status through, chainably', () => {
		expect(result.assertOk()).toBe(result);
	});

	it('assertOk names the status and the stderr on a nonzero exit', () => {
		const bad = _makeRunResult(70, '/boom.php', new Uint8Array(0), fromUtf8('Fatal error: x'));
		try {
			bad.assertOk();
			expect.unreachable('70 is not ok');
		} catch (error) {
			expect((error as InterpreterError).code).toBe('interpreter.nonzero_exit');
			expect((error as Error).message).toContain('70');
			expect((error as Error).message).toContain('/boom.php');
			expect((error as Error).message).toContain('Fatal error');
		}
	});

	it('says so explicitly when a nonzero exit produced no stderr', () => {
		const silent = _makeRunResult(1, '/x', new Uint8Array(0), new Uint8Array(0));
		expect(() => silent.assertOk()).toThrow('(no stderr)');
	});

	it('truncates a very long stderr to 400 characters', () => {
		const long = _makeRunResult(1, '/x', new Uint8Array(0), fromUtf8('e'.repeat(5000)));
		try {
			long.assertOk();
			expect.unreachable('nonzero');
		} catch (error) {
			expect((error as Error).message).toContain('e'.repeat(400));
			expect((error as Error).message).not.toContain('e'.repeat(401));
		}
	});
});
