import { describe, expect, it } from 'vitest';
import { createCartridge, type Interpreter, type InterpreterIo } from '../src/cartridge.js';
import { InterpreterError } from '../src/errors.js';
import { createMemoryFS, type MountFS } from '../src/mount.js';

/**
 * One spec per recipe in ADVANCED_USAGE.md.
 *
 * What these prove and what they do not. Each `it` below drives the adapter shape a recipe documents -- the code a consumer
 * writes between their wasm module and `createCartridge()` -- over a stand-in module. So a recipe
 * whose adapter is wrong cannot pass here, and a doc snippet cannot drift from the API without
 * turning this file red.
 *
 * They do NOT prove that any particular language's wasm build exists or exports what the recipe says
 * it does. That is a build-flag fact about someone else's toolchain. `tests/interpreters/` is the
 * lane that answers it, by installing real builds -- wasmoon, Pyodide, quickjs-emscripten -- and
 * driving them through this package for real; it runs under node rather than workerd, and on every
 * push through `e2e.yml`. A passing test HERE is evidence about the interface, never about a binary.
 *
 * ADVANCED_USAGE.md carries the per-recipe verdict, and every label in it is backed by one of the
 * two lanes.
 */

/** the `main()`-style module shape emscripten produces with `-sINVOKE_RUN=0` */
function mainStyleModule(
	io: InterpreterIo,
	run: (source: string, argv: string[], io: InterpreterIo) => number
): Interpreter {
	const fs = createMemoryFS();
	return {
		FS: fs,
		callMain(argv: string[]): number {
			// a real interpreter reads its script off argv, from the FS; so does this
			const path = argv[argv.length - 1] ?? '';
			return run(fs.readText(path) ?? '', argv, io);
		}
	};
}

describe('recipe: a main()-style interpreter (the PHP, CPython and Ruby shape)', () => {
	it('runs a script read off argv and returns its stdout', async () => {
		const cartridge = createCartridge({
			instantiate: (io) =>
				mainStyleModule(io, (source, _argv, out) => {
					// stands in for the interpreter evaluating the file argv named
					out.print(`evaluated: ${source}`);
					return 0;
				})
		});

		const result = await cartridge.run('echo "hello";');
		expect(result.stdoutText.trim()).toBe('evaluated: echo "hello";');
		expect(result.status).toBe(0);
	});

	it('passes interpreter flags through a custom argv builder', async () => {
		// `php -f /path` and `python /path` differ only here, which is why argv is a function
		let seen: string[] = [];
		const cartridge = createCartridge({
			instantiate: (io) =>
				mainStyleModule(io, (_source, argv) => {
					seen = argv;
					return 0;
				}),
			scriptName: 'main.php',
			argv: (path) => ['php', '-d', 'memory_limit=64M', '-f', path]
		});
		await cartridge.run('<?php echo 1;');
		expect(seen).toEqual(['php', '-d', 'memory_limit=64M', '-f', '/cartridge/main.php']);
	});
});

describe('recipe: a library-style embedding (the QuickJS and Lua shape)', () => {
	it('adapts an eval-shaped API into callMain in two lines', async () => {
		/**
		 * The shape a library embedding actually has: no `main`, no argv, one eval entry point. The
		 * recipe is to write `callMain` as the adapter, which is why `Interpreter` asks for a function
		 * rather than for emscripten's own export.
		 */
		const sources = createMemoryFS();
		const evaluate = (source: string): string => `[${source.length} chars evaluated]`;

		const cartridge = createCartridge({
			instantiate: (io): Interpreter => ({
				FS: sources,
				callMain: (argv: string[]): number => {
					io.print(evaluate(sources.readText(argv[0] ?? '') ?? ''));
					return 0;
				}
			})
		});

		expect((await cartridge.run('1 + 1')).stdoutText.trim()).toBe('[5 chars evaluated]');
	});
});

describe('recipe: structured input and structured output', () => {
	it('hands a value in with writeJson and takes one back with json()', async () => {
		const files = createMemoryFS();
		const cartridge = createCartridge({
			instantiate: (io): Interpreter => ({
				FS: files,
				callMain: (): number => {
					// stands in for the script reading its input file and printing a JSON result
					const input = JSON.parse(files.readText('/cartridge/input.json') ?? 'null') as {
						items: number[];
					};
					io.print(JSON.stringify({ total: input.items.reduce((a, b) => a + b, 0) }));
					return 0;
				}
			})
		});

		await cartridge.writeJson('input.json', { items: [1, 2, 3, 4] });
		const result = await cartridge.run('read input.json, print a total');
		// no TextEncoder and no TextDecoder anywhere in this recipe, which is the point of it
		expect(result.json<{ total: number }>().total).toBe(10);
	});
});

describe('recipe: treating a nonzero exit as a failure', () => {
	it('assertOk turns a status into a named error carrying stderr', async () => {
		const cartridge = createCartridge({
			instantiate: (io): Interpreter => ({
				FS: createMemoryFS(),
				callMain: (): number => {
					io.printErr('Fatal error: Uncaught TypeError');
					return 255;
				}
			})
		});

		const result = await cartridge.run('boom');
		// the status is data, so a script that exits 1 on purpose is not an exception
		expect(result.status).toBe(255);
		try {
			result.assertOk();
			expect.unreachable('255 is not ok');
		} catch (error) {
			expect(error).toBeInstanceOf(InterpreterError);
			expect((error as Error).message).toContain('Uncaught TypeError');
		}
	});
});

describe('recipe: two interpreters in one isolate', () => {
	it('keeps their gates and masks separate', async () => {
		const make = (name: string) =>
			createCartridge({
				instantiate: (io): Interpreter => ({
					FS: createMemoryFS(),
					callMain: (): number => {
						io.print(name);
						return 0;
					}
				})
			});
		const php = make('php');
		const python = make('python');

		expect((await php.run('a')).stdoutText.trim()).toBe('php');
		expect((await python.run('b')).stdoutText.trim()).toBe('python');
		// one C-side mask counter per interpreter, so one host mask each: sharing the module
		// singleton across two would make both depths wrong
		expect(php.stats().mask.enters).toBe(1);
		expect(python.stats().mask.enters).toBe(1);
		expect(php.stats().runs).toBe(1);
		expect(python.stats().runs).toBe(1);
	});
});

describe('recipe: files that outlive one run', () => {
	it('mounts a library once at boot and reuses it across runs', async () => {
		const store = createMemoryFS();
		let writes = 0;
		// composed rather than patched: this recipe is the one that asserts on the NUMBER of writes,
		// which a plain memory FS has no reason to count
		const counting: MountFS = {
			mkdir: () => undefined,
			writeFile: (path: string, data: Uint8Array | string) => {
				writes++;
				store.writeFile(path, data);
			}
		};
		const cartridge = createCartridge({
			instantiate: (io): Interpreter => ({
				FS: counting,
				callMain: (): number => {
					io.print(store.readText('/cartridge/lib/util.py') ?? 'MISSING');
					return 0;
				}
			}),
			files: { 'lib/util.py': 'def helper(): pass' }
		});

		expect((await cartridge.run('a')).stdoutText.trim()).toBe('def helper(): pass');
		expect((await cartridge.run('b')).stdoutText.trim()).toBe('def helper(): pass');
		// the library was written once at boot; each run wrote only its own script
		expect(writes).toBe(3);
	});
});
