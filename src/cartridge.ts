/**
 * The high-level default: hand it a wasm interpreter, get back something you can call.
 *
 * The interpreter arrives as `{ FS, callMain }`. See ADVANCED_USAGE.md for the adapter each
 * language needs.
 */

import { GateError, InterpreterError } from './errors';
import { createMask, type Mask, type MaskStats } from './mask';
import { mkdirp, mountRecord, type FileMap, type MountFS } from './mount';
import { Gate, doGate, type BlockingContext, type GateLike, type GateStats } from './serialize';
import { concatBytes, decodeJson, encodeJson, splitLines, toBytes, toUtf8 } from './util';

/**
 * Where the interpreter's stdout and stderr go while it runs.
 *
 * This is emscripten's `print`/`printErr` pair, which it calls once per LINE with the newline
 * already stripped. `createCartridge()` passes its own collectors in, so a caller's `instantiate`
 * only has to forward them into the module options.
 */
export interface InterpreterIo {
	/** one line of stdout, newline stripped */
	print(line: string): void;
	/** one line of stderr, newline stripped */
	printErr(line: string): void;
}

/**
 * What a wasm interpreter has to look like for a cartridge to drive it.
 *
 * Two members, both of them things emscripten already exports. Anything wider is the caller's to
 * reach for through `interpreter()`.
 */
export interface Interpreter {
	/** the emscripten FS object; a cartridge writes scripts and mounts through this */
	FS: MountFS;
	/** runs `main(argc, argv)` and returns its exit status */
	callMain(argv: string[]): number | void;
}

/** the options `createCartridge()` takes; everything but `instantiate` has a default */
export interface CartridgeOptions {
	/**
	 * Instantiates the interpreter, once, inside the gate.
	 *
	 * Called with the io collectors the cartridge wants wired into the module. Async is expected: an
	 * emscripten factory returns a promise.
	 */
	instantiate: (io: InterpreterIo) => Interpreter | Promise<Interpreter>;
	/** files written into the FS immediately after instantiation, before the first run */
	files?: FileMap;
	/** directory scripts are written to; created on boot */
	scriptDir?: string;
	/** basename `run()` writes its script to, inside `scriptDir` */
	scriptName?: string;
	/** builds the argv for a script path; the default is the path alone */
	argv?: (scriptPath: string) => string[];
	/** an existing gate to share, for a caller that gates more than the interpreter */
	gate?: Gate;
	/** a Durable Object state, which upgrades the gate to also stop event delivery */
	ctx?: BlockingContext;
	/** an existing mask to share; defaults to a fresh one, NOT the module singleton */
	mask?: Mask;
}

/** per-run overrides */
export interface RunOptions {
	/** replaces the computed argv entirely */
	argv?: string[];
	/** files written before this run only */
	files?: FileMap;
	/** where to write the script; defaults to the cartridge's script path */
	path?: string;
}

/**
 * One run's outcome.
 *
 * Bytes AND decoded text are both present, always. The bytes are the primitive and the text is the
 * thing a caller actually wanted, and offering only one of them is how a library ends up with a
 * `TextDecoder` in every consumer.
 */
export interface RunResult {
	/** exit status; 0 for a `main` that returned nothing */
	status: number;
	/** the script path that was run */
	path: string;
	stdout: Uint8Array;
	stderr: Uint8Array;
	/** stdout, UTF-8 decoded */
	stdoutText: string;
	/** stderr, UTF-8 decoded */
	stderrText: string;
	/** stdout parsed as JSON */
	json<T = unknown>(): T;
	/** stdout as lines, without a trailing empty element */
	lines(): string[];
	firstLine(): string;
	lastLine(): string;
	/** 0-based; negative counts from the end */
	lineAt(index: number): string;
	/** throws unless the status is 0, naming the status and stderr */
	assertOk(): RunResult;
}

/** what `stats()` reports: the gate, the mask, and this cartridge's own counters */
export interface CartridgeStats {
	gate: GateStats;
	mask: MaskStats;
	runs: number;
	booted: boolean;
	filesWritten: number;
}

/** the surface `createCartridge()` returns */
export interface Cartridge {
	/** writes a script and runs it */
	run(script: string | Uint8Array, options?: RunOptions): Promise<RunResult>;
	/** runs a script already in the FS */
	runFile(path: string, options?: RunOptions): Promise<RunResult>;
	/** writes files into the FS, gated so it cannot land mid-run */
	write(files: FileMap): Promise<number>;
	/** serialises a value to JSON and writes it, so a caller never builds an encoder */
	writeJson(path: string, value: unknown): Promise<number>;
	/** instantiates if needed and hands back the raw module: the escape hatch */
	interpreter(): Promise<Interpreter>;
	/** runs `fn` inside the gate with the raw module, for anything this surface does not cover */
	withInterpreter<T>(
		fn: (interpreter: Interpreter) => T | Promise<T>,
		label?: string
	): Promise<T>;
	/** throws `GateError` if the gate ever saw two runs at once; a no-op assertion otherwise */
	assertSerialised(): void;
	stats(): CartridgeStats;
}

/** default directory for scripts; absolute because emscripten's cwd is not worth depending on */
export const DEFAULT_SCRIPT_DIR = '/cartridge';

/** default basename inside `DEFAULT_SCRIPT_DIR` */
export const DEFAULT_SCRIPT_NAME = 'main';

/** the one flag line every entry-point message points at, so the four cannot drift apart */
const EXPORT_FLAG = '-sEXPORTED_RUNTIME_METHODS=callMain,FS';

/**
 * Why a value cannot be driven as an `Interpreter`, or null if it can.
 *
 * NAMES THE MISSING MEMBER, because "no { FS, callMain }" is the least actionable half of a build
 * problem: of the four real wasm builds this project has driven, exactly one exports `callMain`.
 * Pyodide exposes a complete `FS` and no `callMain`; wasmoon exposes an `FS` without `utime` and no
 * `callMain`; quickjs-emscripten exposes neither. Each needs a different fix, and a caller cannot
 * pick it from a message that lumps all three together.
 *
 * READING A MEMBER CAN THROW, which is the non-obvious half. Emscripten replaces an unexported
 * runtime method with a getter that calls `abort()`, so `typeof made.callMain` on wasmoon's raw
 * module raises `RuntimeError: Aborted('callMain' was not exported...)` -- a raw wasm error out of
 * `boot()` instead of this package's named one. The read is guarded for exactly that.
 *
 * @internal Exported for the gate lane; the shape it guards is `Interpreter`, which is public.
 *
 * @param made
 *   Whatever `instantiate()` resolved to.
 * @returns
 *   A message naming what is wrong, or null when the value is drivable.
 */
export function _entryPointProblem(made: Interpreter | null | undefined): string | null {
	if (!made || (typeof made !== 'object' && typeof made !== 'function')) {
		return `instantiate() resolved to ${made === null ? 'null' : typeof made}, not a module with { FS, callMain }`;
	}
	let callMain: unknown;
	try {
		callMain = made.callMain;
	} catch (cause) {
		return `reading callMain off the module threw (${String(cause)}): emscripten aborts on an unexported runtime method, so build with ${EXPORT_FLAG} or hand createCartridge() an adapter instead of the raw module`;
	}
	if (!made.FS) {
		return `instantiate() returned a module with no FS: build with ${EXPORT_FLAG}, or supply one -- createMemoryFS() is a MountFS over a Map`;
	}
	if (typeof callMain !== 'function') {
		return `instantiate() returned a module with no callMain: build with ${EXPORT_FLAG}, or write callMain as a two-line adapter over the module's own entry point (Pyodide, wasmoon and quickjs-emscripten all need that)`;
	}
	return null;
}

/**
 * Builds a run result around collected output.
 *
 * @internal Exported for the gate lane, and because the accessors are worth testing without a wasm
 * module in the way.
 *
 * @param status
 *   The exit status.
 * @param path
 *   The script that produced it.
 * @param stdout
 *   Collected stdout.
 * @param stderr
 *   Collected stderr.
 * @returns
 *   The result, with every accessor bound.
 */
export function _makeRunResult(
	status: number,
	path: string,
	stdout: Uint8Array,
	stderr: Uint8Array
): RunResult {
	const stdoutText = toUtf8(stdout);
	const stderrText = toUtf8(stderr);
	const result: RunResult = {
		status,
		path,
		stdout,
		stderr,
		stdoutText,
		stderrText,
		json: <T = unknown>(): T => decodeJson<T>(stdout),
		lines: () => splitLines(stdoutText),
		firstLine: () => splitLines(stdoutText)[0] ?? '',
		lastLine: () => {
			const all = splitLines(stdoutText);
			return all[all.length - 1] ?? '';
		},
		lineAt: (index: number) => {
			const all = splitLines(stdoutText);
			return all[index < 0 ? all.length + index : index] ?? '';
		},
		assertOk: () => {
			if (status !== 0) {
				throw new InterpreterError(
					`the interpreter exited ${status} running ${path}: ${
						stderrText.slice(0, 400) || '(no stderr)'
					}`,
					'interpreter.nonzero_exit'
				);
			}
			return result;
		}
	};
	return result;
}

/**
 * Wires an interpreter into a gate, a mask and a filesystem, and returns something callable.
 *
 * @param options
 *   At minimum an `instantiate`; see `CartridgeOptions`.
 * @returns
 *   The cartridge. Nothing is instantiated until the first call that needs the interpreter.
 *
 * @example
 * ```ts
 * import { createCartridge } from '@drupflare/cartridge';
 *
 * const cartridge = createCartridge({
 * 	instantiate: (io) => initInterpreter({ print: io.print, printErr: io.printErr }),
 * 	files: { 'lib/helper.txt': 'shared by every run' }
 * });
 *
 * const result = await cartridge.run('print("hello")');
 * console.log(result.stdoutText);
 * ```
 */
export function createCartridge(options: CartridgeOptions): Cartridge {
	const scriptDir = (options.scriptDir ?? DEFAULT_SCRIPT_DIR).replace(/\/+$/, '');
	const scriptName = options.scriptName ?? DEFAULT_SCRIPT_NAME;
	const scriptPath = `${scriptDir}/${scriptName}`;
	const buildArgv = options.argv ?? ((path: string) => [path]);
	const baseGate = options.gate ?? new Gate();
	// doGate() only reaches for blockConcurrencyWhile when a ctx was given, so this is the same gate
	// in a plain Worker and a stronger one in a Durable Object
	const gate: GateLike = options.ctx ? doGate(baseGate, options.ctx) : baseGate;
	// a FRESH mask by default, not the module singleton: two cartridges in one isolate are two
	// interpreters with two C-side counters, and sharing one host counter would make the depth wrong
	const mask = options.mask ?? createMask();

	let instance: Interpreter | null = null;
	let booting: Promise<Interpreter> | null = null;
	let runs = 0;
	let filesWritten = 0;

	/** current run's collected output; replaced per run so a stray late line cannot cross runs */
	let outChunks: Uint8Array[] = [];
	let errChunks: Uint8Array[] = [];

	/**
	 * The io the interpreter writes through.
	 *
	 * MASKED, and this is the load-bearing part of the wiring. `print` is a JS frame executing
	 * underneath the interpreter's own stack, which is exactly the shape that cannot be suspended
	 * (`SuspendError: trying to suspend JS frames`). The mask holds the interrupt off for its
	 * duration and releases it after, so a slice boundary lands between lines rather than inside one.
	 */
	const io: InterpreterIo = {
		print(line: string): void {
			mask.withMask(() => {
				outChunks.push(toBytes(`${line}\n`));
			});
		},
		printErr(line: string): void {
			mask.withMask(() => {
				errChunks.push(toBytes(`${line}\n`));
			});
		}
	};

	/** instantiates once; a second concurrent caller awaits the first rather than booting again */
	function boot(): Promise<Interpreter> {
		if (instance) return Promise.resolve(instance);
		if (booting) return booting;
		booting = (async () => {
			let made: Interpreter;
			try {
				made = await options.instantiate(io);
			} catch (cause) {
				// cleared so a transient failure can be retried; a stuck promise would make one bad
				// boot permanent for the life of the isolate
				booting = null;
				throw new InterpreterError(
					`instantiate() failed: ${String(cause)}`,
					'interpreter.instantiate_failed'
				);
			}
			const problem = _entryPointProblem(made);
			if (problem) {
				booting = null;
				throw new InterpreterError(problem, 'interpreter.no_entry_point');
			}
			mkdirp(made.FS, scriptDir);
			if (options.files) {
				filesWritten += mountRecord(made.FS, options.files, scriptDir).files;
			}
			instance = made;
			return made;
		})();
		return booting;
	}

	/** the one place `callMain` is entered, always inside the gate and never inside the mask */
	function execute(interpreter: Interpreter, path: string, argv: string[]): RunResult {
		outChunks = [];
		errChunks = [];
		let status = 0;
		try {
			// NOT masked. The mask exists to hold the interrupt off across a HOST call that puts a JS
			// frame under the interpreter; the interpreter's own execution is the stack the slice is
			// supposed to be able to interrupt, so masking here would silently disable slicing
			status = Number(interpreter.callMain(argv) ?? 0);
		} catch (cause) {
			// emscripten throws ExitStatus for a nonzero exit(); anything else is a real fault
			const exitStatus = (cause as { status?: unknown } | null)?.status;
			if (typeof exitStatus !== 'number') {
				runs++;
				throw new InterpreterError(
					`the interpreter threw running ${path}: ${String(cause)}`,
					'interpreter.threw'
				);
			}
			status = exitStatus;
		}
		runs++;
		if (mask.depth() !== 0) {
			// a leaked depth means every later suspension is masked forever, so slicing stops
			// happening and the dev assertion that would catch it never runs
			const depth = mask.depth();
			mask.reset();
			throw new InterpreterError(
				`mask depth ${depth} after ${path}: a host callback did not unmask`,
				'interpreter.mask_leaked'
			);
		}
		return _makeRunResult(status, path, concatBytes(outChunks), concatBytes(errChunks));
	}

	function write(files: FileMap): Promise<number> {
		return gate.run(async () => {
			const interpreter = await boot();
			const written = mountRecord(interpreter.FS, files, scriptDir);
			filesWritten += written.files;
			return written.files;
		}, 'write');
	}

	return {
		run(script: string | Uint8Array, runOptions: RunOptions = {}): Promise<RunResult> {
			const path = runOptions.path ?? scriptPath;
			return gate.run(async () => {
				const interpreter = await boot();
				if (runOptions.files) {
					filesWritten += mountRecord(interpreter.FS, runOptions.files, scriptDir).files;
				}
				filesWritten += mountRecord(interpreter.FS, { [path]: script }).files;
				return execute(interpreter, path, runOptions.argv ?? buildArgv(path));
			}, `run ${path}`);
		},

		runFile(path: string, runOptions: RunOptions = {}): Promise<RunResult> {
			return gate.run(async () => {
				const interpreter = await boot();
				if (runOptions.files) {
					filesWritten += mountRecord(interpreter.FS, runOptions.files, scriptDir).files;
				}
				return execute(interpreter, path, runOptions.argv ?? buildArgv(path));
			}, `runFile ${path}`);
		},

		write,

		// async so an unencodable value arrives as a REJECTION; a declared-Promise function that
		// throws synchronously slips past every `.catch()` a caller writes
		async writeJson(path: string, value: unknown): Promise<number> {
			return write({ [path]: encodeJson(value) });
		},

		interpreter(): Promise<Interpreter> {
			return gate.run(() => boot(), 'interpreter');
		},

		withInterpreter<T>(
			fn: (interpreter: Interpreter) => T | Promise<T>,
			label = 'withInterpreter'
		): Promise<T> {
			return gate.run(async () => fn(await boot()), label);
		},

		assertSerialised(): void {
			const seen = gate.stats().maxConcurrent;
			if (seen > 1) {
				throw new GateError(
					`the gate observed ${seen} concurrent runs, so serialisation failed`,
					'gate.concurrency_observed'
				);
			}
		},

		stats(): CartridgeStats {
			return {
				gate: gate.stats(),
				mask: mask.stats(),
				runs,
				booted: instance !== null,
				filesWritten
			};
		}
	};
}
