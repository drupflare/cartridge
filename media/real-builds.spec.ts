import { describe, expect, it } from 'vitest';
import { createCartridge, type Interpreter } from '../../src/cartridge.js';
import { createMemoryFS, type FileMap, type MountFS } from '../../src/mount.js';
import { toBytes } from '../../src/util.js';

/**
 * Real wasm interpreter builds, driven through `createCartridge()` for real.
 *
 * `tests/recipes.spec.ts` proves the ADAPTER SHAPE over stand-in
 * modules, and it says so in its own docblock: a green result there is evidence about the interface,
 * never about a binary. This file is the only thing that puts a real binary behind a claim, and
 * ADVANCED_USAGE.md's status table is defined by it: a language is Verified when a test HERE drives
 * it and passes, and Not verified otherwise. It covers every language with an installable build.
 *
 * Every build here reaches for its own wasm off disk:
 * wasmoon reads `glue.wasm`, Pyodide reads a 9.6 MB `pyodide.asm.wasm` plus a 2.5 MB stdlib zip,
 * quickjs-emscripten resolves a variant package, ruby.wasm is a 30 MB file this spec compiles,
 * php-wasm's `PhpNode` statically imports `node:fs` to locate a 12.6 MB build in its own package
 * directory. None of that is reachable from inside workerd, and workerd additionally blocks
 * request-time wasm codegen, which is why `drupflare/worker` ships its binary as a module-scope
 * import. So what this lane proves is that a real build SATISFIES THE CONTRACT this package defines
 * -- `{ FS, callMain }`, a script written into the interpreter's own filesystem, output collected
 * off `print` -- and not that any of these five fits in a Worker. ADVANCED_USAGE.md states that
 * split per recipe.
 *
 * WHAT THE FIVE ACTUALLY MEASURED, which is a finding about the contract's generality rather than
 * about any one build:
 *
 * | build                     | FS                          | callMain     |
 * | ------------------------- | --------------------------- | ------------ |
 * | wasmoon (Lua 5.4)         | real emscripten, NO `utime` | not exported |
 * | Pyodide (CPython 3)       | real emscripten, complete   | not exported |
 * | quickjs-emscripten        | none at all                 | not exported |
 * | ruby.wasm (CRuby 3.4)     | WASI preopen, no emscripten | not exported |
 * | php-wasm (PHP 8.3)        | real emscripten, complete   | not exported |
 *
 * Ruby is the one that is not emscripten at all. `MountFS` is three method signatures rather than a
 * reference to emscripten's object, so a WASI preopen directory satisfies it in a ten-line adapter
 * and the script still lands in the filesystem CRuby itself reads through.
 */

/**
 * Imports an interpreter package, answering null rather than throwing when it is absent.
 *
 * Every one is a pinned `devDependency`, so `bun install` puts it here and renovate's npm manager
 * can bump it -- a version buried in a shell script or a workflow `env:` gets no bump PR and rots
 * silently, which is the failure this whole lane exists to prevent. The tolerance is for a working
 * copy with a partial `node_modules`, not for CI: the guard below turns that case red.
 *
 * The specifier is a VARIABLE on purpose. A literal would make `tsc` resolve each package's types,
 * and the shapes below are deliberately hand-written slivers so this file states what it actually
 * relies on rather than inheriting five upstream type surfaces.
 *
 * @param name
 *   The package to import.
 * @returns
 *   Its namespace, or null when it is not installed.
 */
async function optionalImport(name: string): Promise<Record<string, unknown> | null> {
	try {
		return (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** every interpreter this lane claims to cover, and the package that provides it */
const REQUIRED = [
	'wasmoon',
	'pyodide',
	'quickjs-emscripten',
	'@ruby/wasm-wasi',
	'@bjorn3/browser_wasi_shim',
	'php-wasm/PhpNode'
] as const;

const loaded = new Map<string, Record<string, unknown> | null>();

for (const name of REQUIRED) {
	loaded.set(name, await optionalImport(name));
}

/**
 * CRuby itself, which is a data file rather than a module.
 *
 * `@ruby/wasm-wasi` is only the glue; the binary ships in a per-version package beside it and there
 * is nothing to import, so it is resolved as a path and read as bytes. `+stdlib` is the build that
 * carries `json` and `stringio` -- the bare `ruby.wasm` boots and prints, then writes four
 * "were not loaded" lines to stderr and cannot `require` anything.
 */
const RUBY_WASM = '@ruby/3.4-wasm-wasi/dist/ruby+stdlib.wasm';

/**
 * node's own modules, reached the same variable-specifier way as the interpreters.
 *
 * The tsconfig's `types` array is `@cloudflare/workers-types` alone, so there is no `node:fs` type
 * to import statically -- and adding one would type node globals into `src/` as well, where nothing
 * may use them.
 */
const nodeModule = (await optionalImport('node:module')) as unknown as {
	createRequire(from: string): { resolve(id: string): string };
} | null;

const nodeFs = (await optionalImport('node:fs/promises')) as unknown as {
	readFile(path: string): Promise<Uint8Array>;
} | null;

/** `import.meta.url` is untyped for the same reason; workerd has no module-relative resolution */
const HERE = (import.meta as unknown as { url: string }).url;

const rubyWasmPath = ((): string | null => {
	try {
		return nodeModule?.createRequire(HERE).resolve(RUBY_WASM) ?? null;
	} catch {
		return null;
	}
})();

/**
 * Compiles wasm bytes.
 *
 * `WebAssembly.compile` is ABSENT FROM `@cloudflare/workers-types` on purpose -- workerd blocks
 * request-time codegen, and `Module` is declared abstract there to say so. The cast is local rather
 * than an ambient widening so that guard keeps holding for `src/`; this lane runs under node.
 */
function compileWasm(bytes: Uint8Array): Promise<WebAssembly.Module> {
	return (
		WebAssembly as unknown as { compile(b: Uint8Array): Promise<WebAssembly.Module> }
	).compile(bytes);
}

const missing = [
	...REQUIRED.filter((name) => loaded.get(name) === null),
	...(rubyWasmPath === null ? [RUBY_WASM] : [])
];

// A MISSING INTERPRETER MUST NOT SILENTLY PASS THIS FILE. A working copy with a partial
// node_modules should not see red, but a CI run that skipped the only place a real build is ever
// driven is indistinguishable from one that verified every build -- and the labels in
// ADVANCED_USAGE.md are the whole value of that document. Same rule
// `worker/tests/node/php-fragments.spec.ts` follows when `php` is missing and CI is set.
if (missing.length > 0 && process.env.CI) {
	throw new Error(
		`not installed and CI is set: ${missing.join(', ')}. The interpreter verification would ` +
			'silently skip, leaving ADVANCED_USAGE.md claiming Verified for a build nothing ran. ' +
			'They are pinned devDependencies, so run `bun install --frozen-lockfile`, or narrow ' +
			'deliberately what the document claims.'
	);
}

/** `Interpreter.FS` is `MountFS`; a real emscripten FS is far wider and structurally compatible */
function asMountFS(FS: unknown): MountFS {
	return FS as MountFS;
}

describe('the loader itself, so a green run is not vacuous', () => {
	it('answers null for a package that is not installed', async () => {
		// without this, every skipIf below could be reading a helper that never returns null, and the
		// loud-failure guard above would never fire no matter what CI had failed to install
		expect(await optionalImport('@drupflare/definitely-not-a-real-package')).toBeNull();
	});

	it('answers a namespace for one that is', async () => {
		expect(await optionalImport('fflate')).not.toBeNull();
	});
});

describe.skipIf(loaded.get('wasmoon') === null)('Lua 5.4, via wasmoon', () => {
	/**
	 * The adapter, and the two things it says about the contract.
	 *
	 * `FS` IS THE BUILD'S OWN. `wasm.module.FS` is the real emscripten MEMFS, so `cartridge.run()`
	 * writes the script through `mountRecord()` into the interpreter's actual filesystem and Lua
	 * reads it back with `luaL_loadfilex`. Nothing is faked on that path.
	 *
	 * `callMain` IS NOT. wasmoon does not export it, and reading it does not merely answer undefined
	 * -- emscripten replaces an unexported runtime method with a getter that calls `abort()`, so
	 * `typeof wasm.module.callMain` raises a `RuntimeError`. The adapter supplies one over
	 * `doFileSync`, which is the library-style recipe.
	 */
	async function luaCartridge() {
		const mod = loaded.get('wasmoon') as { LuaFactory: new () => LuaFactoryLike };
		return createCartridge({
			instantiate: async (io): Promise<Interpreter> => {
				const factory = new mod.LuaFactory();
				const wasm = await factory.getLuaModule();
				const engine = await factory.createEngine();
				// Lua's own print writes to stdout, which node owns; routing it through io.print is
				// what puts a JS frame under the interpreter, which is what the mask is for
				engine.global.set('print', (...args: unknown[]) =>
					io.print(args.map((arg) => String(arg)).join('\t'))
				);
				return {
					FS: asMountFS(wasm.module.FS),
					callMain: (argv: string[]): number => {
						try {
							engine.doFileSync(argv[argv.length - 1] ?? '');
							return 0;
						} catch (cause) {
							io.printErr(String(cause));
							return 1;
						}
					}
				};
			},
			scriptName: 'main.lua',
			argv: (path) => ['lua', path]
		});
	}

	it('exposes a real emscripten FS with mkdir and writeFile', async () => {
		const mod = loaded.get('wasmoon') as { LuaFactory: new () => LuaFactoryLike };
		const wasm = await new mod.LuaFactory().getLuaModule();
		expect(typeof wasm.module.FS.mkdir).toBe('function');
		expect(typeof wasm.module.FS.writeFile).toBe('function');
	});

	it('has NO utime, which is why MountFS declares it optional', async () => {
		// this is the measurement that widened the type. A required `utime` would have excluded a
		// build this file otherwise drives end to end, for a call only mountDrupalStreaming makes
		const mod = loaded.get('wasmoon') as { LuaFactory: new () => LuaFactoryLike };
		const wasm = await new mod.LuaFactory().getLuaModule();
		expect(wasm.module.FS.utime).toBeUndefined();
	});

	it("runs a script cartridge wrote into the build's own filesystem", async () => {
		const cartridge = await luaCartridge();
		const result = await cartridge.run('print("lua " .. _VERSION)\nprint(1 + 1)');
		expect(result.status).toBe(0);
		expect(result.firstLine()).toBe('lua Lua 5.4');
		expect(result.lastLine()).toBe('2');
	});

	it('reads a file writeJson put there, so the FS round-trips', async () => {
		const cartridge = await luaCartridge();
		await cartridge.writeJson('input.json', { items: [1, 2, 3, 4] });
		const result = await cartridge.run(
			'local f = io.open("/cartridge/input.json", "r")\n' +
				'local body = f:read("*a")\n' +
				'f:close()\n' +
				'print(body)\n'
		);
		expect(result.json<{ items: number[] }>().items).toEqual([1, 2, 3, 4]);
	});

	it('reports a Lua error as a status rather than as an exception', async () => {
		const cartridge = await luaCartridge();
		const result = await cartridge.run('error("boom")');
		expect(result.status).toBe(1);
		expect(result.stderrText).toContain('boom');
		expect(() => result.assertOk()).toThrow(/exited 1/);
	});

	it('leaves the mask at depth 0, so slicing could still land between lines', async () => {
		const cartridge = await luaCartridge();
		await cartridge.run('print("a")\nprint("b")');
		const stats = cartridge.stats();
		expect(stats.mask.depth).toBe(0);
		// two prints, two masked host callbacks, from inside a real interpreter's stack
		expect(stats.mask.enters).toBe(2);
	});
});

describe.skipIf(loaded.get('pyodide') === null)('CPython 3, via Pyodide', () => {
	/**
	 * Pyodide is a real CPython built to wasm32-emscripten, and its `FS` is the complete one --
	 * `utime` included, unlike wasmoon's. What it does not have is `callMain`: `_module.callMain` is
	 * `undefined`, which settles the open question ADVANCED_USAGE.md recorded against this recipe.
	 * The adapter runs the file with `runpy`, so the script cartridge wrote is opened and compiled by
	 * CPython itself rather than handed to it as a string.
	 */
	const pyodide = () =>
		loaded.get('pyodide') as { loadPyodide: (options: unknown) => Promise<PyodideLike> };

	/** one instance for the shape assertions; a load is ~1.5 s and neither of them writes anything */
	let inspected: Promise<PyodideLike> | null = null;
	const inspect = () => (inspected ??= pyodide().loadPyodide({}));

	async function pythonCartridge() {
		const mod = pyodide();
		return createCartridge({
			instantiate: async (io): Promise<Interpreter> => {
				const py = await mod.loadPyodide({ stdout: io.print, stderr: io.printErr });
				return {
					FS: asMountFS(py.FS),
					callMain: (argv: string[]): number => {
						const path = argv[argv.length - 1] ?? '';
						try {
							py.runPython(
								`import runpy; runpy.run_path(${JSON.stringify(path)}, run_name='__main__')`
							);
							return 0;
						} catch (cause) {
							io.printErr(String(cause));
							return 1;
						}
					}
				};
			},
			scriptName: 'main.py',
			argv: (path) => ['python', path]
		});
	}

	it('exposes a COMPLETE emscripten FS, utime included', async () => {
		const py = await inspect();
		expect(typeof py.FS.mkdir).toBe('function');
		expect(typeof py.FS.writeFile).toBe('function');
		expect(typeof py.FS.utime).toBe('function');
	});

	it('exports no callMain, so Python is a library-style embedding', async () => {
		// ADVANCED_USAGE.md used to record this as unverified: "whether it exposes callMain at all".
		// It does not, and that is now measured rather than guessed
		const py = await inspect();
		expect(py._module.callMain).toBeUndefined();
	});

	it('runs a script cartridge wrote, and hands back parsed JSON', async () => {
		const cartridge = await pythonCartridge();
		const result = await cartridge.run(
			'import json, sys\nprint(json.dumps({"major": sys.version_info[0]}))\n'
		);
		expect(result.status).toBe(0);
		expect(result.json<{ major: number }>().major).toBe(3);
	});

	it('drives the structured-io recipe end to end, with no encoder in caller code', async () => {
		const cartridge = await pythonCartridge();
		await cartridge.writeJson('input.json', { items: [1, 2, 3, 4] });
		const result = await cartridge.run(
			'import json\n' +
				"with open('/cartridge/input.json') as f:\n" +
				"\tprint(json.dumps({'total': sum(json.load(f)['items'])}))\n"
		);
		expect(result.json<{ total: number }>().total).toBe(10);
	});

	it('mounts a library at boot that a later script imports', async () => {
		const mod = pyodide();
		const cartridge = createCartridge({
			instantiate: async (io): Promise<Interpreter> => {
				const py = await mod.loadPyodide({ stdout: io.print, stderr: io.printErr });
				return {
					FS: asMountFS(py.FS),
					callMain: (argv: string[]): number => {
						py.runPython(
							`import sys; sys.path.insert(0, '/cartridge'); import runpy; runpy.run_path(${JSON.stringify(
								argv[argv.length - 1] ?? ''
							)}, run_name='__main__')`
						);
						return 0;
					}
				};
			},
			scriptName: 'main.py',
			argv: (path) => ['python', path],
			files: { 'helper.py': 'def double(n):\n\treturn n * 2\n' }
		});
		const result = await cartridge.run('from helper import double\nprint(double(21))\n');
		expect(result.firstLine()).toBe('42');
	});

	it('reports a Python traceback as a status rather than as an exception', async () => {
		const cartridge = await pythonCartridge();
		const result = await cartridge.run('raise ValueError("boom")\n');
		expect(result.status).toBe(1);
		expect(result.stderrText).toContain('boom');
	});
});

describe.skipIf(loaded.get('quickjs-emscripten') === null)(
	'QuickJS, via quickjs-emscripten',
	() => {
		/**
		 * The weakest of the three against the contract, and worth having for exactly that reason.
		 * quickjs-emscripten's module exports NEITHER member: its runtime-method list is trimmed to
		 * `cwrap`, `UTF8ToString` and the heap views, so there is no `FS` at all and no `callMain`. Both
		 * halves of the adapter are host-side -- `createMemoryFS()` for the filesystem, a `newContext()`
		 * eval for the entry point -- which is the case the library-style recipe describes.
		 *
		 * What is still real: the wasm QuickJS engine parses and executes the script, and `print` inside
		 * it is a host function calling back out through the mask.
		 */
		async function quickjsCartridge() {
			const mod = loaded.get('quickjs-emscripten') as {
				getQuickJS: () => Promise<QuickJSLike>;
			};
			const files = createMemoryFS();
			const cartridge = createCartridge({
				instantiate: async (io): Promise<Interpreter> => {
					const QuickJS = await mod.getQuickJS();
					return {
						FS: files,
						callMain: (argv: string[]): number => {
							const ctx = QuickJS.newContext();
							try {
								const print = ctx.newFunction('print', (...args: unknown[]) =>
									io.print(args.map((arg) => String(ctx.dump(arg))).join(' '))
								);
								ctx.setProp(ctx.global, 'print', print);
								print.dispose();
								const evaluated = ctx.evalCode(
									files.readText(argv[argv.length - 1] ?? '') ?? ''
								);
								if (evaluated.error) {
									io.printErr(
										String(
											(ctx.dump(evaluated.error) as { message?: unknown })
												?.message ?? evaluated.error
										)
									);
									evaluated.error.dispose();
									return 1;
								}
								evaluated.value.dispose();
								return 0;
							} finally {
								ctx.dispose();
							}
						}
					};
				},
				scriptName: 'main.js',
				argv: (path) => ['qjs', path]
			});
			return { cartridge, files };
		}

		it('exports neither FS nor callMain, so the adapter supplies both', async () => {
			const mod = loaded.get('quickjs-emscripten') as {
				getQuickJS: () => Promise<QuickJSLike>;
			};
			const QuickJS = await mod.getQuickJS();
			expect(QuickJS.module.FS).toBeUndefined();
			expect(QuickJS.module.callMain).toBeUndefined();
		});

		it('runs a script through the real engine and collects its output', async () => {
			const { cartridge } = await quickjsCartridge();
			const result = await cartridge.run('print("qjs " + (1 + 1));');
			expect(result.status).toBe(0);
			expect(result.firstLine()).toBe('qjs 2');
		});

		it('put the script in the adapter FS at the path cartridge reports', async () => {
			const { cartridge, files } = await quickjsCartridge();
			const result = await cartridge.run('print(1);');
			expect(result.path).toBe('/cartridge/main.js');
			expect(files.readText('/cartridge/main.js')).toBe('print(1);');
		});

		it('reports a thrown JS error as a status rather than as an exception', async () => {
			const { cartridge } = await quickjsCartridge();
			const result = await cartridge.run('throw new Error("boom");');
			expect(result.status).toBe(1);
			expect(result.stderrText).toContain('boom');
		});

		it('serialises two runs and leaves the mask balanced', async () => {
			const { cartridge } = await quickjsCartridge();
			await Promise.all([cartridge.run('print("a");'), cartridge.run('print("b");')]);
			cartridge.assertSerialised();
			expect(cartridge.stats().mask.depth).toBe(0);
			expect(cartridge.stats().runs).toBe(2);
		});
	}
);

const rubyReady =
	loaded.get('@ruby/wasm-wasi') !== null &&
	loaded.get('@bjorn3/browser_wasi_shim') !== null &&
	rubyWasmPath !== null;

describe.skipIf(!rubyReady)('CRuby 3.4, via ruby.wasm', () => {
	/**
	 * The only build here that is not emscripten, which is what it is worth having for.
	 *
	 * `MountFS` is three method signatures rather than a reference to emscripten's `FS` object, so a
	 * WASI preopen directory satisfies it -- `wasiMountFS()` below is the whole adapter. The script
	 * `cartridge.run()` writes lands in the directory CRuby reads through `Kernel#load`, and
	 * `File.read` in a script sees what `writeJson()` put there, so nothing on that path is faked.
	 *
	 * `callMain` is host-side for the usual reason: `RubyVM` exposes `eval` and no entry point.
	 */

	/** read once; the +stdlib binary is 30 MB and every test in this describe compiles it */
	let binary: Promise<Uint8Array> | null = null;
	const rubyBinary = () =>
		(binary ??= (nodeFs as { readFile(p: string): Promise<Uint8Array> }).readFile(
			rubyWasmPath as string
		));

	/** a `MountFS` over a WASI preopen; paths arrive absolute and a preopen's are relative to it */
	function wasiMountFS(root: PreopenDirectoryLike): MountFS {
		const entry = (path: string, isDir: boolean) => {
			const made = root.dir.create_entry_for_path(path.replace(/^\/+/, ''), isDir);
			if (made.ret !== 0 || !made.entry) {
				throw new Error(`wasi refused ${path}: errno ${made.ret}`);
			}
			return made.entry;
		};
		return {
			mkdir: (path: string): void => void entry(path, true),
			writeFile: (path: string, data: Uint8Array | string): void => {
				entry(path, false).data = toBytes(data);
			}
		};
	}

	async function rubyCartridge() {
		const shim = loaded.get('@bjorn3/browser_wasi_shim') as unknown as WasiShimLike;
		const { RubyVM } = loaded.get('@ruby/wasm-wasi') as unknown as { RubyVM: RubyVMStatic };
		const root = new shim.PreopenDirectory('/', new Map());
		const cartridge = createCartridge({
			instantiate: async (io): Promise<Interpreter> => {
				const wasi = new shim.WASI(
					['ruby'],
					[],
					[
						new shim.OpenFile(new shim.File([])),
						// one call per newline-terminated line, which is the same contract
						// emscripten's print has, so the mask counts one enter per line
						shim.ConsoleStdout.lineBuffered(io.print),
						shim.ConsoleStdout.lineBuffered(io.printErr),
						root
					],
					{ debug: false }
				);
				const module = await compileWasm(await rubyBinary());
				const { vm } = await RubyVM.instantiateModule({ module, wasip1: wasi });
				return {
					FS: wasiMountFS(root),
					callMain: (argv: string[]): number => {
						try {
							vm.eval(`load ${JSON.stringify(argv[argv.length - 1] ?? '')}`);
							return 0;
						} catch (cause) {
							io.printErr(String(cause));
							return 1;
						}
					}
				};
			},
			scriptName: 'main.rb',
			argv: (path) => ['ruby', path]
		});
		return { cartridge, root };
	}

	it('exposes neither member, because WASI is not emscripten', async () => {
		const shim = loaded.get('@bjorn3/browser_wasi_shim') as unknown as WasiShimLike;
		const { RubyVM } = loaded.get('@ruby/wasm-wasi') as unknown as { RubyVM: RubyVMStatic };
		const fds = [
			new shim.OpenFile(new shim.File([])),
			shim.ConsoleStdout.lineBuffered(() => {}),
			shim.ConsoleStdout.lineBuffered(() => {}),
			new shim.PreopenDirectory('/', new Map())
		];
		const wasi = new shim.WASI(['ruby'], [], fds, { debug: false });
		const module = await compileWasm(await rubyBinary());
		const { vm } = await RubyVM.instantiateModule({ module, wasip1: wasi });
		const raw = vm as unknown as Record<string, unknown>;
		expect(raw.FS).toBeUndefined();
		expect(raw.callMain).toBeUndefined();
	});

	it("runs a script cartridge wrote into the interpreter's own filesystem", async () => {
		const { cartridge } = await rubyCartridge();
		const result = await cartridge.run('puts "ruby #{RUBY_VERSION}"\nputs 1 + 1\n');
		expect(result.status).toBe(0);
		expect(result.firstLine()).toMatch(/^ruby 3\.4/);
		expect(result.lastLine()).toBe('2');
	});

	it('writes the script through the WASI preopen the VM reads', async () => {
		const { cartridge, root } = await rubyCartridge();
		const result = await cartridge.run('puts 1');
		expect(result.path).toBe('/cartridge/main.rb');
		// the same Map CRuby resolved `load` against, so the run above was not reading a copy
		const dir = root.dir.contents.get('cartridge') as { contents: Map<string, unknown> };
		expect(dir.contents.has('main.rb')).toBe(true);
	});

	it('reads a file writeJson put there, so the FS round-trips', async () => {
		const { cartridge } = await rubyCartridge();
		await cartridge.writeJson('input.json', { items: [1, 2, 3, 4] });
		const result = await cartridge.run(
			"require 'json'\n" +
				"items = JSON.parse(File.read('/cartridge/input.json'))['items']\n" +
				"puts JSON.generate({ 'total' => items.sum })\n"
		);
		expect(result.json<{ total: number }>().total).toBe(10);
	});

	it('reports a Ruby exception as a status rather than as an exception', async () => {
		const { cartridge } = await rubyCartridge();
		const result = await cartridge.run('raise "boom"');
		expect(result.status).toBe(1);
		expect(result.stderrText).toContain('boom');
		expect(() => result.assertOk()).toThrow(/exited 1/);
	});

	it('leaves the mask at depth 0, one enter per line', async () => {
		const { cartridge } = await rubyCartridge();
		await cartridge.run('puts "a"\nputs "b"');
		const stats = cartridge.stats();
		expect(stats.mask.depth).toBe(0);
		expect(stats.mask.enters).toBe(2);
	});
});

describe.skipIf(loaded.get('php-wasm/PhpNode') === null)('PHP 8.3, via php-wasm', () => {
	/**
	 * The language this package was extracted from, driven through a build nobody here compiled.
	 *
	 * `FS` IS THE BUILD'S OWN, and it is the complete emscripten one with `utime`. `callMain` is not
	 * exported, so the adapter enters through `pib_run` -- php-wasm's own entry point -- with a
	 * `require` of the path `cartridge.run()` wrote. PHP opens and compiles that file out of its own
	 * filesystem; nothing is handed to it as a string.
	 *
	 * TWO ADAPTER OBLIGATIONS THE OTHER FOUR DO NOT HAVE.
	 *
	 * OUTPUT ARRIVES AS BYTES. php-wasm pipes emscripten's stdout into an `OutputBuffer` that fires an
	 * `output` event per newline with the newline still attached, so the adapter strips it and calls
	 * `flush()` after every run. Skip the flush and a last line with no trailing newline stays in the
	 * byte buffer and reappears glued to the FRONT of the next run's first line.
	 *
	 * FATALS DO NOT REACH STDERR BY DEFAULT. `display_errors = stderr` is a CLI-SAPI setting and this
	 * build is `embed`, so the fatal lands on stdout and corrupts `result.json()`. Measured: with
	 * `display_errors = 1` an uncaught `RuntimeException` writes six lines to `print`. `log_errors`
	 * with `error_log = /dev/stderr` is the route that reaches `printErr`.
	 */
	const phpModule = () =>
		loaded.get('php-wasm/PhpNode') as { PhpNode: new (args: PhpArgsLike) => PhpNodeLike };

	/** the package ships one wasm per PHP version, so naming one keeps the lane to a single read */
	const PHP_BUILD = '8.3';

	const PHP_INI = [
		'display_errors = 0',
		'log_errors = 1',
		'error_log = /dev/stderr',
		'error_reporting = E_ALL',
		'html_errors = 0'
	].join('\n');

	/** the buffer flushed on a newline and kept it; `io.print` takes lines without one */
	const stripEol = (chunk: string): string => (chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk);

	/** one instance for the shape assertions; neither of them writes anything */
	let inspected: Promise<PhpModuleLike> | null = null;
	const inspect = () => {
		const { PhpNode } = phpModule();
		return (inspected ??= new PhpNode({ version: PHP_BUILD }).binary);
	};

	async function phpCartridge(files?: FileMap) {
		const { PhpNode } = phpModule();
		return createCartridge({
			instantiate: async (io): Promise<Interpreter> => {
				const php = new PhpNode({ version: PHP_BUILD, ini: PHP_INI });
				php.onoutput = (event) => io.print(stripEol(event.detail[0] ?? ''));
				php.onerror = (event) => io.printErr(stripEol(event.detail[0] ?? ''));
				const mod = await php.binary;
				return {
					FS: asMountFS(mod.FS),
					callMain: (argv: string[]): number => {
						const path = argv[argv.length - 1] ?? '';
						try {
							// pib_run compiles its argument as PHP, so `?>` opens output mode first
							return Number(
								mod.ccall(
									'pib_run',
									'number',
									['string'],
									[`?><?php require ${JSON.stringify(path)};`]
								)
							);
						} finally {
							php.flush();
						}
					}
				};
			},
			scriptName: 'main.php',
			argv: (path) => ['php', path],
			files
		});
	}

	it('exposes a COMPLETE emscripten FS, utime included', async () => {
		const mod = await inspect();
		expect(typeof mod.FS.mkdir).toBe('function');
		expect(typeof mod.FS.writeFile).toBe('function');
		expect(typeof mod.FS.utime).toBe('function');
	});

	it('exports no callMain, so the published PHP is a library-style embedding', async () => {
		// the build in `drupflare/worker` exports it and this one does not, so the flagship language
		// needs the same adapter as the other four rather than the main()-style recipe
		const mod = await inspect();
		expect(mod.callMain).toBeUndefined();
	});

	it("runs a script cartridge wrote into the build's own filesystem", async () => {
		const cartridge = await phpCartridge();
		const result = await cartridge.run(
			'<?php echo "php " . PHP_VERSION . "\\n"; echo 1 + 1, "\\n";'
		);
		expect(result.status).toBe(0);
		expect(result.path).toBe('/cartridge/main.php');
		expect(result.firstLine()).toMatch(/^php 8\.3\./);
		expect(result.lastLine()).toBe('2');
	});

	it('reads a file writeJson put there, so the FS round-trips', async () => {
		const cartridge = await phpCartridge();
		await cartridge.writeJson('input.json', { items: [1, 2, 3, 4] });
		const result = await cartridge.run(
			'<?php\n' +
				'$items = json_decode(file_get_contents("/cartridge/input.json"), true)["items"];\n' +
				'echo json_encode(["total" => array_sum($items)]);\n'
		);
		expect(result.json<{ total: number }>().total).toBe(10);
	});

	it('mounts a library at boot that a later script requires', async () => {
		const cartridge = await phpCartridge({
			'helper.php': '<?php function double(int $n): int { return $n * 2; }'
		});
		const result = await cartridge.run(
			'<?php require "/cartridge/helper.php"; echo double(21), "\\n";'
		);
		expect(result.firstLine()).toBe('42');
	});

	it('flushes a last line with no newline instead of carrying it into the next run', async () => {
		const cartridge = await phpCartridge();
		const first = await cartridge.run('<?php echo "no newline here";');
		const second = await cartridge.run('<?php echo "second\\n";');
		expect(first.stdoutText).toBe('no newline here\n');
		expect(second.firstLine()).toBe('second');
	});

	it('reports a PHP fatal as a status rather than as an exception', async () => {
		const cartridge = await phpCartridge();
		const result = await cartridge.run('<?php throw new RuntimeException("boom");');
		expect(result.status).toBe(2);
		expect(result.stdoutText).toBe('');
		expect(result.stderrText).toContain('boom');
		expect(() => result.assertOk()).toThrow(/exited 2/);
	});

	it('leaves the mask at depth 0, one enter per line', async () => {
		const cartridge = await phpCartridge();
		await cartridge.run('<?php echo "a\\n"; echo "b\\n";');
		const stats = cartridge.stats();
		expect(stats.mask.depth).toBe(0);
		expect(stats.mask.enters).toBe(2);
	});
});

/** the sliver of wasmoon this file touches; the package's own types are not installed for `tsc` */
interface LuaFactoryLike {
	getLuaModule(): Promise<{ module: { FS: Record<string, unknown> } }>;
	createEngine(): Promise<{
		global: { set(name: string, value: unknown): void };
		doFileSync(path: string): unknown;
	}>;
}

/** the sliver of Pyodide this file touches */
interface PyodideLike {
	FS: Record<string, unknown>;
	_module: { callMain?: unknown };
	runPython(source: string): unknown;
}

/** the sliver of quickjs-emscripten this file touches */
interface QuickJSLike {
	module: { FS?: unknown; callMain?: unknown };
	newContext(): QuickJSContextLike;
}

interface QuickJSHandleLike {
	dispose(): void;
}

interface QuickJSContextLike {
	global: QuickJSHandleLike;
	newFunction(name: string, fn: (...args: unknown[]) => void): QuickJSHandleLike;
	setProp(target: QuickJSHandleLike, key: string, value: QuickJSHandleLike): void;
	evalCode(source: string): {
		error?: QuickJSHandleLike;
		value: QuickJSHandleLike;
	};
	dump(handle: unknown): unknown;
	dispose(): void;
}

/** a WASI directory entry, narrowed to the field the mount adapter assigns */
interface WasiInodeLike {
	data: Uint8Array;
	contents: Map<string, unknown>;
}

/** the preopen the Ruby adapter mounts through */
interface PreopenDirectoryLike {
	dir: {
		contents: Map<string, unknown>;
		create_entry_for_path(
			path: string,
			isDir: boolean
		): { ret: number; entry: WasiInodeLike | null };
	};
}

/** the sliver of @bjorn3/browser_wasi_shim this file touches */
interface WasiShimLike {
	WASI: new (
		args: string[],
		env: string[],
		fds: unknown[],
		options: { debug: boolean }
	) => {
		wasiImport: WebAssembly.ModuleImports;
		initialize(instance: WebAssembly.Instance): void;
	};
	File: new (data: number[]) => unknown;
	OpenFile: new (file: unknown) => unknown;
	PreopenDirectory: new (name: string, contents: Map<string, unknown>) => PreopenDirectoryLike;
	ConsoleStdout: { lineBuffered(write: (line: string) => void): unknown };
}

/** the php-wasm constructor arguments this file sets */
interface PhpArgsLike {
	version: string;
	ini?: string;
}

/** the sliver of php-wasm's PhpNode this file touches */
interface PhpNodeLike {
	binary: Promise<PhpModuleLike>;
	onoutput: (event: { detail: string[] }) => void;
	onerror: (event: { detail: string[] }) => void;
	flush(): void;
}

/** the emscripten module underneath PhpNode, narrowed to what the adapter drives */
interface PhpModuleLike {
	FS: Record<string, unknown>;
	callMain?: unknown;
	ccall(name: string, returns: string, argTypes: string[], args: unknown[]): unknown;
}

/** the sliver of @ruby/wasm-wasi this file touches */
interface RubyVMStatic {
	instantiateModule(options: {
		module: WebAssembly.Module;
		wasip1: {
			wasiImport: WebAssembly.ModuleImports;
			initialize(i: WebAssembly.Instance): void;
		};
	}): Promise<{ vm: { eval(source: string): unknown } }>;
}
