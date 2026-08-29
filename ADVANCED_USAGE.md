# Advanced Usage

Recipes for driving a wasm interpreter through `createCartridge()`, and the status of every language
this document names.

## Language Status

A language is **Verified** when a test in [`tests/interpreters/`](./tests/interpreters/) installs a
real build from npm, drives it through this package, and passes. Everything else is **Not verified**.
There is no third state. Run the lane with `bun run test:interpreters`.

| Language                           | Adapter | Status           | Note                                                                               |
| ---------------------------------- | ------- | ---------------- | ---------------------------------------------------------------------------------- |
| PHP 8.3, php-wasm 0.1.0            | yes     | **Verified**     | supplies `callMain` and a line split; 182 MB installed, one 12.6 MB wasm read      |
| Lua 5.4, wasmoon 1.16.0            | yes     | **Verified**     | supplies `callMain`; the build's emscripten `FS` has no `utime`                    |
| CPython 3, Pyodide 314.0.3         | yes     | **Verified**     | supplies `callMain`; 9.6 MB wasm plus a 2.5 MB stdlib zip                          |
| QuickJS, quickjs-emscripten 0.32.0 | yes     | **Verified**     | supplies both members; the build exports no filesystem                             |
| CRuby 3.4, ruby.wasm 2.10.1        | yes     | **Verified**     | supplies both members; the filesystem is a WASI preopen, not emscripten            |
| PHP 8.3, `drupflare/worker`        | no      | **Not verified** | a second build: exports `callMain` and `FS`, serves Drupal 11 on a deployed Worker |
| Java, @gmitch215/bytebox 1.0.0     | yes     | **Verified**     | npm ships the loader, not a runtime; the lane carries the 19 KB compiled program   |

Verified says the build satisfies `{ FS, callMain }`, that a script `cartridge.run()` wrote lands in
the filesystem the interpreter reads, and that output comes back off `print`. It says nothing about
whether that build fits a Worker. Pyodide's wasm alone is 9.6 MB against a 3 MB gzipped bundle
ceiling, CRuby's is 30 MB and php-wasm's PHP 8.3 is 12.6 MB. Each recipe states its own size and
runtime limits.

PHP holds two rows because two different builds exist. php-wasm 0.1.0 is the published one this lane
drives; the one in [`drupflare/worker`](https://github.com/drupflare/worker) is compiled separately,
exports `callMain` and `FS` directly, and runs on the edge. Neither is evidence for the other.

Two languages are absent from the table with nothing to install: `webperl`, `bash-wasm`,
`wasm-bash` and `busybox-wasm` are all 404 on npm, so Perl and bash have no candidate build.

Java is Verified on a different arrangement of the same parts. It is the only compiled language
here: `@gmitch215/bytebox` publishes a loader and a Gradle build produces the wasm, so what npm
installs is the loader and the wasm is the program rather than a language runtime. The lane carries
that program as a committed 19 KB `tests/fixtures/java.wasm` and drives it through the installed
loader.

Every recipe's adapter shape is also exercised over stand-in modules in
[`tests/recipes.spec.ts`](./tests/recipes.spec.ts), in the workerd lane.

---

## Contents

- [The Interpreter Contract](#the-interpreter-contract)
- [PHP 8.3](#php-83)
- [The Edge PHP Build](#the-edge-php-build)
- [CPython 3](#cpython-3)
- [Lua 5.4](#lua-54)
- [QuickJS](#quickjs)
- [CRuby 3.4](#cruby-34)
- [Java](#java)
- [Structured Input and Output](#structured-input-and-output)
- [Interpreter Flags and Argv](#interpreter-flags-and-argv)
- [A Nonzero Exit](#a-nonzero-exit)
- [Two Interpreters in One Isolate](#two-interpreters-in-one-isolate)
- [A Big Tree, Mounted Lazily](#a-big-tree-mounted-lazily)
- [A Mutable Layer in R2](#a-mutable-layer-in-r2)
- [Inside a Durable Object](#inside-a-durable-object)
- [The Supervisor on the Response Path](#the-supervisor-on-the-response-path)
- [The Tail Worker](#the-tail-worker)
- [Driving the Pieces by Hand](#driving-the-pieces-by-hand)
- [The Verification Lanes](#the-verification-lanes)
- [Things That Will Bite You](#things-that-will-bite-you)

---

## The Interpreter Contract

Two members.

```ts
import type { Interpreter, InterpreterIo } from '@drupflare/cartridge';

// FS: a filesystem object, narrowed to mkdir / writeFile / optional utime
// callMain: runs the script at the end of argv and returns its exit status
```

For a `main()`-having program, emscripten produces both with:

- `-sINVOKE_RUN=0`, so instantiating the module does not run `main`. Without it the program runs
  once at instantiation, before any script has been written, and `callMain` runs it again.
- `-sEXPORTED_RUNTIME_METHODS=callMain,FS`, so the two members survive minification.
- `-sMODULARIZE=1`, so you get a factory to call inside `instantiate`.

> [!IMPORTANT]
> **No off-the-shelf build in this document exports `callMain`.** Six were installed and checked:
>
> | Build                       | `FS`                        | `callMain`   |
> | --------------------------- | --------------------------- | ------------ |
> | wasmoon 1.16.0 (Lua 5.4)    | real emscripten, no `utime` | not exported |
> | Pyodide 314.0.3 (CPython 3) | real emscripten, complete   | not exported |
> | quickjs-emscripten 0.32.0   | none at all                 | not exported |
> | ruby.wasm 2.10.1 (CRuby)    | WASI preopen, no emscripten | not exported |
> | php-wasm 0.1.0 (PHP 8.3)    | real emscripten, complete   | not exported |
> | @gmitch215/bytebox (Java)   | none at all                 | not exported |
>
> PHP 8.3 in `drupflare/worker` exports it, that build having been made with the flag above; the
> published PHP does not. The `main()` recipe is the exception among published builds and the two-line
> `callMain` adapter is the normal case. `Interpreter.callMain` is typed as a function you supply for
> that reason, and `MountFS.utime` is optional for the same one.
>
> **Reading an unexported member can throw rather than answer `undefined`.** emscripten replaces one
> with a getter that calls `abort()`, so `typeof module.callMain` on wasmoon's raw module raises
> `RuntimeError: Aborted('callMain' was not exported...)`. `createCartridge()` guards that read and
> reports `interpreter.no_entry_point` naming the member.

`MountFS` is three method signatures rather than a reference to emscripten's object, so a filesystem
that is not emscripten's still satisfies it. [CRuby 3.4](#cruby-34) mounts through a WASI preopen
directory in ten lines, and `createMemoryFS()` covers a build with no filesystem at all.

Two workerd facts about instantiation:

- **workerd blocks request-time wasm codegen.** `new WebAssembly.Module(bytes)` inside a request
  throws. The binary has to be a module-scope import the runtime compiles at deploy time, handed to
  emscripten through `instantiateWasm`.
- **The `ENVIRONMENT=worker` build reads `self.location.href` at module scope.** workerd has `self`
  and no `self.location`, so the glue throws before instantiation. Import
  `@drupflare/cartridge/shim` first, for its effect, before the glue evaluates.

```ts
import '@drupflare/cartridge/shim';
import { createCartridge } from '@drupflare/cartridge';
import wasmModule from './interpreter.wasm'; // compiled at deploy time, not per request
import initInterpreter from './interpreter.mjs';

const cartridge = createCartridge({
  instantiate: (io) =>
    initInterpreter({
      print: io.print,
      printErr: io.printErr,
      instantiateWasm: (imports, done) =>
        WebAssembly.instantiate(wasmModule, imports).then((instance) => done(instance, wasmModule))
    })
});
```

---

## PHP 8.3

**Verified** against php-wasm 0.1.0. The code below is what
[`tests/interpreters/real-builds.spec.ts`](./tests/interpreters/real-builds.spec.ts) runs.

php-wasm exports a complete emscripten `FS`, `utime` included, and no `callMain`. The entry point is
`pib_run`, which compiles a PHP source string, so the adapter passes it a `require` of the path
`cartridge.run()` wrote and PHP opens the file out of its own filesystem.

The package is **182 MB installed** and ships twelve wasm builds, one per PHP version and
environment. Naming a `version` picks one glue module, which reads one wasm: 12.6 MB for 8.3. There
is no smaller sub-package to install instead.

```ts
import { createCartridge, type Interpreter } from '@drupflare/cartridge';
import { PhpNode } from 'php-wasm/PhpNode';

// `embed` ignores `display_errors = stderr`, so a fatal reaches printErr through the log
const ini = 'display_errors = 0\nlog_errors = 1\nerror_log = /dev/stderr\nerror_reporting = E_ALL';

const php = createCartridge({
  instantiate: async (io): Promise<Interpreter> => {
    const runtime = new PhpNode({ version: '8.3', ini });
    // php-wasm buffers stdout bytes and fires one event per newline, newline attached
    runtime.onoutput = (event) => io.print(event.detail[0].replace(/\n$/, ''));
    runtime.onerror = (event) => io.printErr(event.detail[0].replace(/\n$/, ''));
    const module = await runtime.binary;
    return {
      FS: module.FS,
      callMain: (argv) => {
        const path = argv[argv.length - 1];
        try {
          // pib_run compiles its argument as PHP, so `?>` opens output mode first
          return module.ccall('pib_run', 'number', ['string'], [`?><?php require "${path}";`]);
        } finally {
          runtime.flush();
        }
      }
    };
  },
  scriptName: 'main.php',
  argv: (path) => ['php', path]
});

const result = await php.run('<?php echo json_encode(["v" => PHP_VERSION]);');
result.json<{ v: string }>().v; // "8.3.11"
```

Three things this build needs that the other four do not.

`flush()` after every run. A last line with no trailing newline stays in the byte buffer and
arrives glued to the front of the next run's first line, so `result.json()` on run two parses run
one's tail.

`error_log = /dev/stderr`. `display_errors = stderr` is a CLI-SAPI setting and this build is
`embed`. Left at `display_errors = 1`, an uncaught `RuntimeException` writes six lines to `print`
and `result.stdoutText` is no longer the script's output. Routed through the log, a fatal is
`status === 2` with stdout empty.

`exit()` ends the runtime rather than the run. After `<?php exit(3);` the status is still 0 and
every later run through the same instance produces nothing.

---

## The Edge PHP Build

**Not verified.** A separate build, compiled by
[`drupflare/phasm`](https://github.com/drupflare/phasm) and running in
[`drupflare/worker`](https://github.com/drupflare/worker), serving Drupal 11 out of a Durable Object
on a deployed Worker. It exports `{ FS, callMain }` directly, so it is the one build here that needs
no adapter, and nothing in this repository drives it.

```ts
const php = createCartridge({
  instantiate: (io) => initPhp({ print: io.print, printErr: io.printErr, instantiateWasm }),
  scriptName: 'main.php',
  argv: (path) => ['php', path]
});

const result = await php.run('<?php echo json_encode(["v" => PHP_VERSION]);');
result.json<{ v: string }>().v; // "8.3.x"
```

Build flags that are load-bearing:

| Flag                                      | Effect                                                                                                                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-sASYNCIFY=0`                            | Asyncify cost 42% of the bundle and bought nothing once the database was synchronous DO SQLite. Removing it fit a 3 MB gzipped ceiling                                                                                           |
| `-sJSPI` **and** `-sSUPPORT_LONGJMP=wasm` | plain `-sJSPI` makes every run die, including `<?php echo PHP_VERSION;`, with `SuspendError: trying to suspend JS frames`: `pib_run` opens a `zend_try` (setjmp) before entering the VM, so an `invoke_*` JS frame sits under it |
| `-sSUPPORT_LONGJMP=wasm` is compile-time  | relinking an LTO object built without it aborts `wasm-ld` with `LLVM ERROR: Cannot select: ... catchret`, so a finished build cannot be converted after the fact                                                                 |
| `ENVIRONMENT=worker`                      | a smaller shim surface than the browser build: no document, no window, no screen                                                                                                                                                 |
| a `zend_interrupt_function` patch         | what `mask.ts` drives; exports `zend_wasm_slice_arm/_mask/_stat` at +0.45% (paired interleaved, n=200000)                                                                                                                        |

> [!CAUTION]
> **`ASYNCIFY=0` leaves the `http` and `https` stream wrappers advertised and broken.**
> `stream_get_wrappers()` still lists them, and reading through the native wrapper throws
> `ReferenceError: Asyncify is not defined` out of a wasm import: the glue has two
> `Asyncify.handleAsync(...)` call sites and declares `Asyncify` nowhere. PHP cannot catch it. `@`
> and `catch (\Throwable)` were both measured useless from two unrelated routes, and the whole
> invocation dies with no PHP fatal, no `printErr` and no logger output. Import
> `@drupflare/cartridge/shim`, which stubs the object and returns `-1` rather than `0` (`0` is taken
> as a valid stream handle one layer further in), and shadow both schemes from PHP with
> [`drupflare/stream-http`](https://github.com/drupflare/stream-http).

---

## CPython 3

**Verified** against Pyodide 314.0.3. The code below is what
[`tests/interpreters/real-builds.spec.ts`](./tests/interpreters/real-builds.spec.ts) runs.

Pyodide exports a complete emscripten `FS`, `utime` included, and no `callMain`
(`pyodide._module.callMain` is `undefined`). The script `cartridge.run()` writes goes into CPython's
own filesystem and `runpy` opens it there.

```ts
import { createCartridge, type Interpreter } from '@drupflare/cartridge';
import { loadPyodide } from 'pyodide';

const python = createCartridge({
  instantiate: async (io): Promise<Interpreter> => {
    const py = await loadPyodide({ stdout: io.print, stderr: io.printErr });
    return {
      FS: py.FS,
      callMain: (argv) => {
        const path = argv[argv.length - 1] ?? '';
        py.runPython(`import runpy; runpy.run_path(${JSON.stringify(path)}, run_name='__main__')`);
        return 0;
      }
    };
  },
  scriptName: 'main.py',
  argv: (path) => ['python', path],
  files: { 'helper.py': 'def double(n):\n\treturn n * 2\n' }
});

const result = await python.run(
  'import json, sys\nprint(json.dumps({"major": sys.version_info[0]}))'
);
result.json<{ major: number }>().major; // 3
```

> [!CAUTION]
> **This does not fit a Worker, for size rather than interface.** Pyodide ships a 9.6 MB
> `pyodide.asm.wasm` plus a 2.5 MB stdlib zip against a 3 MB gzipped ceiling, and reads both off the
> local filesystem at load time, which workerd does not have. The verification runs under node.

For Python on the edge, two routes remain, both Not verified:

| Route                              | Shape                         | Open question                                                                                        |
| ---------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| CPython built to wasm32-emscripten | upstream supports the target  | the flag set that yields `callMain` + `FS` under workerd, and the size with a trimmed stdlib         |
| CPython on WASI                    | `wasi` rather than emscripten | a WASI preopen needs a `MountFS` adapter; [CRuby 3.4](#cruby-34) is the worked example of that shape |

---

## Lua 5.4

**Verified** against wasmoon 1.16.0.

wasmoon exposes a real emscripten MEMFS, so `cartridge.run()` writes the script through it and Lua
reads it back with `luaL_loadfilex`. Only `callMain` is host-side.

```ts
import { createCartridge, type Interpreter } from '@drupflare/cartridge';
import { LuaFactory } from 'wasmoon';

const lua = createCartridge({
  instantiate: async (io): Promise<Interpreter> => {
    const factory = new LuaFactory();
    const wasm = await factory.getLuaModule();
    const engine = await factory.createEngine();
    engine.global.set('print', (...args: unknown[]) => io.print(args.map(String).join('\t')));
    return {
      FS: wasm.module.FS,
      callMain: (argv) => {
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

(await lua.run('print("lua " .. _VERSION)')).firstLine(); // "lua Lua 5.4"
```

> [!NOTE]
> **wasmoon's `FS` has no `utime`.** `MountFS.utime` is optional for that reason, and only
> `mountDrupalStreaming()` ever calls it.

---

## QuickJS

**Verified** against quickjs-emscripten 0.32.0.

quickjs-emscripten trims its exported runtime methods to `cwrap`, `UTF8ToString` and the heap views,
so there is no `FS` and no `callMain`. Both halves are host-side, and `createMemoryFS()` is the
filesystem half. The wasm engine still parses and executes the script, and `print` inside it is a
host function calling back through the mask.

```ts
import { createCartridge, createMemoryFS, type Interpreter } from '@drupflare/cartridge';
import { getQuickJS } from 'quickjs-emscripten';

const files = createMemoryFS();

const qjs = createCartridge({
  instantiate: async (io): Promise<Interpreter> => {
    const QuickJS = await getQuickJS();
    return {
      FS: files,
      callMain: (argv) => {
        const ctx = QuickJS.newContext();
        try {
          const print = ctx.newFunction('print', (...args) =>
            io.print(args.map((arg) => String(ctx.dump(arg))).join(' '))
          );
          ctx.setProp(ctx.global, 'print', print);
          print.dispose();
          const evaluated = ctx.evalCode(files.readText(argv[argv.length - 1] ?? '') ?? '');
          if (evaluated.error) {
            io.printErr(String(ctx.dump(evaluated.error)));
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

(await qjs.run('print("qjs " + (1 + 1));')).firstLine(); // "qjs 2"
```

---

## CRuby 3.4

**Verified** against ruby.wasm 2.10.1 (`@ruby/wasm-wasi` plus the `@ruby/3.4-wasm-wasi` binary).

CRuby is WASI rather than emscripten. `RubyVM` exposes neither `FS` nor `callMain`, so both halves
are host-side, and the filesystem half is a `MountFS` over a `PreopenDirectory` from
`@bjorn3/browser_wasi_shim`. `Kernel#load` and `File.read` inside a script resolve through that same
directory, so the script is not handed to Ruby as a string.

Use `ruby+stdlib.wasm`, 30 MB. The bare `ruby.wasm` boots and prints, then writes four
"were not loaded" lines to stderr and cannot `require`.

```ts
import { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI } from '@bjorn3/browser_wasi_shim';
import { createCartridge, type Interpreter, type MountFS } from '@drupflare/cartridge';
import { RubyVM } from '@ruby/wasm-wasi';

const root = new PreopenDirectory('/', new Map());

// the filesystem half: a preopen's paths are relative to it, and cartridge writes absolute ones
const files: MountFS = {
  mkdir: (path) => void root.dir.create_entry_for_path(path.replace(/^\/+/, ''), true),
  writeFile: (path, data) => {
    const made = root.dir.create_entry_for_path(path.replace(/^\/+/, ''), false);
    if (made.ret !== 0 || !made.entry) throw new Error(`wasi refused ${path}: errno ${made.ret}`);
    made.entry.data = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  }
};

const ruby = createCartridge({
  instantiate: async (io): Promise<Interpreter> => {
    const wasi = new WASI(
      ['ruby'],
      [],
      [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered(io.print),
        ConsoleStdout.lineBuffered(io.printErr),
        root
      ],
      { debug: false }
    );
    const module = await WebAssembly.compile(rubyWasmBytes);
    const { vm } = await RubyVM.instantiateModule({ module, wasip1: wasi });
    return {
      FS: files,
      callMain: (argv) => {
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

(await ruby.run('puts "ruby #{RUBY_VERSION}"')).firstLine(); // "ruby 3.4.x"
```

`ConsoleStdout.lineBuffered` calls its function once per newline-terminated line, which is the
contract emscripten's `print` has, so the mask records one enter per line either way.

---

## Java

**Verified** against `@gmitch215/bytebox` 1.0.0. Earlier notes here recorded a search that found
nothing to install: `teavm` and `cheerpj` are not published to npm, `doppiojvm` last released
2016-10-30 and is TypeScript rather than wasm. [bytebox](https://github.com/gmitch215/bytebox) is a
Java-on-wasm toolchain that does publish, and the code below is what
[`tests/interpreters/real-builds.spec.ts`](./tests/interpreters/real-builds.spec.ts) runs.

Java is not an interpreter, which is what makes the recipe a different shape. bytebox compiles Java
ahead of time through TeaVM's WasmGC backend and the npm package is the loader that runs the result,
so the wasm is your program rather than a language runtime and a JDK 21 and Gradle build produces
it. That is also what Verified covers here and does not cover for the other five: the loader comes
off npm, and the program the lane drives it with is a 19 KB fixture in this repository.

Three consequences for the adapter:

|                                               | Why                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `FS` is `createMemoryFS()`                    | TeaVM emits no emscripten runtime, so there is no filesystem of the build's to hand over            |
| the program reads through a module you supply | `load({ modules })` resolves a specifier the Java source imported; nothing looks it up on disk      |
| `callMain` is `async`                         | a Java thread here is a fiber on the host queue, and work `main` queued has not run when it returns |

```java
@JSBody(
	params = "path",
	imports = @JSBodyImport(alias = "fs", fromModule = "cartridge:fs"),
	script = "return fs.readText(path);"
)
private static native String readText(String path);

public static void main(String[] args) {
	System.out.println(readText(args[args.length - 1]));
}
```

```ts
import {
  createCartridge,
  createMemoryFS,
  type Interpreter,
  type InterpreterIo
} from '@drupflare/cartridge';
import { load } from '@gmitch215/bytebox';
import * as runtime from './app.wasm-runtime.js';
import bytes from './app.wasm';

const fs = createMemoryFS();
let io: InterpreterIo | undefined;

// module scope: load() compiles wasm, and workerd allows that only during module evaluation
const module = load({
  runtime,
  bytes,
  print: (line) => io?.print(line),
  printErr: (line) => io?.printErr(line),
  modules: { 'cartridge:fs': { readText: (path: string) => fs.readText(path) ?? null } }
});

export const java = createCartridge({
  instantiate: (collectors): Interpreter => {
    io = collectors;
    return {
      FS: fs,
      callMain: async (argv): Promise<number> => {
        try {
          module.call('main', argv);
          const drain = await module.drainAsync();
          if (!drain.drained) {
            collectors.printErr(`${drain.pending} fiber(s) still queued after main`);
            return 1;
          }
          return 0;
        } catch (cause) {
          collectors.printErr(`Exception in thread "main" ${String(cause)}`);
          return 1;
        }
      }
    };
  },
  scriptName: 'main.txt',
  argv: (path) => ['java', path]
});

(await java.run('from the cartridge')).lastLine(); // "from the cartridge"
```

**The boot order is inverted from every other recipe here.** The others build their interpreter inside
`instantiate`, which runs lazily inside a request. This one compiles at module scope and rebinds the
collectors per instantiate, because that is the only place a Worker permits wasm compilation. The
consequence is that **one `load()` serves one cartridge**: a second cartridge over the same module
overwrites `io` and both cartridges' output cross-wires.

**A script is data, not code.** An ahead-of-time compiled program is whatever was compiled; `run()`
writes bytes and the path arrives as the last element of argv, so the recipe is `run()` for input and
`runFile()` for something mounted earlier. `writeJson` round-trips through the same path.

**Size is the one thing this recipe has that the others do not.** The wasm holds your program and the
part of the class library it reaches, not a language runtime: the lane's fixture is 19,698 bytes, and
bytebox's own hello world is 16,539 raw and 6,996 gzipped against a 3 MB ceiling. Pyodide's wasm alone
is 9.6 MB and CRuby's is 30 MB. This is the only row in the table that fits a free-tier Worker with
room left over.

---

## Structured Input and Output

**Verified** against Pyodide, CRuby and PHP. No `TextEncoder` or `TextDecoder` in caller code.

```ts
await cartridge.writeJson('input.json', { items: [1, 2, 3, 4] });

const result = await cartridge.run(`
	import json
	with open('/cartridge/input.json') as f:
		print(json.dumps({'total': sum(json.load(f)['items'])}))
`);

result.json<{ total: number }>().total; // 10
```

`writeJson` is `async` so an unencodable value (a cycle, a BigInt, `undefined`) arrives as a
rejection. A declared-`Promise` function that throws synchronously slips past every `.catch()` a
caller writes.

---

## Interpreter Flags and Argv

`php -f /path` and `python /path` differ only in argv, so `argv` is a function of the script path
rather than a string template.

```ts
const cartridge = createCartridge({
  instantiate,
  scriptName: 'main.php',
  argv: (path) => ['php', '-d', 'memory_limit=64M', '-f', path]
});

// or per run, replacing the built argv entirely
await cartridge.run('', { argv: ['php', '--version'] });
```

---

## A Nonzero Exit

An intentional nonzero exit is not a malfunction, so `run()` resolves and puts the status on the
result. `assertOk()` is the opt-in that turns it into an error.

```ts
const result = await cartridge.run(script);
if (result.status !== 0) {
  console.error(result.stderrText); // decoded, and complete
}

// or, when a nonzero exit really is a failure
(await cartridge.run(script)).assertOk();
// InterpreterError: the interpreter exited 255 running /cartridge/main: Fatal error: ...
```

A wasm trap arrives as `InterpreterError` with code `interpreter.threw`;
`RuntimeError: memory access out of bounds` is not an exit status.

---

## Two Interpreters in One Isolate

```ts
const php = createCartridge({ instantiate: initPhp });
const python = createCartridge({ instantiate: initPython });
```

Each gets its own gate and its own mask. One interpreter has one C-side mask counter, and sharing the
module-level singleton across two would make both host depths wrong. `createCartridge()` calls
`createMask()`; the singleton stays exported for the single-interpreter case.

---

## A Big Tree, Mounted Lazily

Reach for this when `mountRecord()` stops being sensible: a large tree where a request touches a
small fraction of it.

```ts
import { mountDrupalLazy } from '@drupflare/cartridge/fs';

const cartridge = createCartridge({
  instantiate: async (io) => {
    const module = await initInterpreter({
      print: io.print,
      printErr: io.printErr,
      instantiateWasm
    });
    await mountDrupalLazy(module, env, { prefix: 'tree-pf' });
    return module;
  }
});
```

Against an 11,421-file Drupal tree in `drupflare/worker`: cold start was 3,754 ms of `cpuTime` and
3,066 ms of that was the mount, 6.1x the local figure. Boot of the interpreter itself was 518-660 ms.
Boot plus one page render read 1,006 of the 11,421 files.

> [!CAUTION]
> **Do not convert the resident blob into range fetches.** Holding all 11.4 MB in memory is the
> design: 1,006 files fetched individually is 1,006 subrequests against a 1,000-per-invocation cap,
> so the range-fetch version cannot serve a single page.

`LAZY_FS_BUDGET_BYTES` (default 20 MB) is not optional. Without it a long-lived object converges on
the union of every route it has ever served, ~52 MB against the streaming mount's 39 MB, since
nothing is released. Eviction is safe: the compressed blob stays resident, so dropping
contents is reversible and re-inflating is idempotent.

---

## A Mutable Layer in R2

```ts
await mountDrupalLazy(module, env, {
  layers: [
    { prefix: 'core-pf', name: 'core' },
    { r2: 'modules', name: 'modules' }
  ]
});
```

- **Layers merge before node creation**, so a later layer overrides an earlier one on the same path.
- **An R2 layer costs zero subrequests.** An ASSETS-backed layer costs two. R2 is the right store for
  the mutable half, and it removes the need for an API token with Workers Scripts edit rights: an
  install writes an object and bumps a generation instead of calling `versions.create`.

---

## Inside a Durable Object

```ts
import { DurableObject } from 'cloudflare:workers';
import { createCartridge, type Cartridge } from '@drupflare/cartridge';

export class InterpreterObject extends DurableObject {
  private cartridge: Cartridge;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // passing ctx upgrades the gate: it also stops the runtime delivering events
    this.cartridge = createCartridge({ instantiate: makeInstantiate(env), ctx });
  }

  async fetch(request: Request): Promise<Response> {
    const result = await this.cartridge.run(await request.text());
    return new Response(result.stdout, { status: result.status === 0 ? 200 : 500 });
  }
}
```

> [!CAUTION]
> **`alarm()` is not gated as a whole while `fetch()` is.** An `alarm()` handler that already holds
> the gate and calls something acquiring it again hangs forever, and it presents as a deadlock while
> actually being starvation. Use `withInterpreter()` once per handler rather than nesting gated
> calls, and never re-arm a failing alarm at a fixed interval: a step that re-armed at +1 ms spun an
> object forever and starved every gated request past 90 s.

---

## The Supervisor on the Response Path

```ts
import {
  CircuitBreaker,
  ensureHealthTable,
  gcHealthLedger,
  quarantineDecision,
  recordFinding,
  runHostTripwires
} from '@drupflare/cartridge/supervisor';

const breaker = new CircuitBreaker();
ensureHealthTable(ctx.storage.sql);

const findings = runHostTripwires({
  status: 200,
  bytes: body.length,
  path: url.pathname,
  medianBytes: rollingMedian,
  maskDepth: cartridge.stats().mask.depth,
  asyncifyCalls: (globalThis as { __cfwAsyncifyCalls?: number }).__cfwAsyncifyCalls
});

for (const finding of findings) {
  const rung = breaker.record(finding.code, finding.severity, Date.now());
  recordFinding(ctx.storage.sql, finding, Date.now(), rung);
}

const { quarantine, reason } = quarantineDecision(findings);
if (quarantine) {
  return new Response(reason, { status: 503, headers: { 'retry-after': '30' } });
}
gcHealthLedger(ctx.storage.sql);
```

Every observation is a scalar the caller already had, so nothing here becomes a full-table scan on
the request path. `gcHealthLedger()` returns what it deleted so you can bill it against a
rows-written budget: an unbounded log table reached 46% of a database before anybody looked.

---

## The Tail Worker

```jsonc
// wrangler.jsonc, in the PRODUCER worker
{ "tail_consumers": [{ "service": "interpreter-tail" }] }
```

```ts
// the consumer worker's entrypoint
export { default } from '@drupflare/cartridge/tail';
```

You get one summary line per batch, PHP-level error lines re-emitted at the top level so they are
greppable without unpacking the summary, and a canary verdict once all three legs of a run have been
observed. Correlation is in memory, so a missed correlation degrades to "incomplete" on the next run
rather than to a wrong verdict.

---

## Driving the Pieces by Hand

The default path is an arrangement of exported parts.

```ts
import { Gate, doGate } from '@drupflare/cartridge/gate';
import { createMask } from '@drupflare/cartridge/mask';
import { mountRecord } from '@drupflare/cartridge/fs';

const gate = doGate(new Gate(), ctx);
const mask = createMask();

const output = await gate.run(async () => {
  mountRecord(module.FS, { '/main.php': source });
  // a host callback goes inside the mask; callMain does NOT
  const rows = mask.withMask(() => queryTheDatabase());
  return module.callMain(['php', '/main.php']);
}, 'one run');
```

**`callMain` goes outside the mask.** The mask holds the interrupt off across a host call that puts a
JS frame under the interpreter. The interpreter's own execution is the stack a slice has to be able
to interrupt, so masking `callMain` disables slicing, and the dev assertion that would catch it never
fires: the suspension never comes.

---

## The Verification Lanes

Two lanes, both on every push.

```sh
bun install --frozen-lockfile
bun run test              # workerd: every recipe's adapter shape, over stand-in modules
bun run test:interpreters # node: the real builds, driven through this package
```

Every interpreter package is a pinned `devDependency`, which is where renovate's npm manager looks. A
version inside a shell script, a `curl` URL or a workflow `env:` gets no bump PR and rots until a
recipe breaks; a renovate PR here is the run that answers whether a recipe still works against the
new release. A devDependency is never installed for a consumer, so the cost falls on contributors and
CI.

[`.github/workflows/e2e.yml`](./.github/workflows/e2e.yml) runs the second lane, built so silence
cannot read as success:

- `bun install --frozen-lockfile` installs the builds, so a missing or drifted one is a failed
  install rather than a skipped suite.
- With `CI` set, a build that is nonetheless absent makes `real-builds.spec.ts` throw at module scope
  rather than leave a `describe` skipped.
- It reads vitest's JSON report and fails if zero tests ran, if any test was skipped, or if the
  report is missing.
- There is no `if:` on the job, and the branch filter is `master`.

A build that stops satisfying the contract turns the lane red on the next push.

---

## Things That Will Bite You

| Symptom                                                      | Cause                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| the request hangs forever, no error                          | the gate was acquired twice inside one call. Starvation, not deadlock                                                                                 |
| `SuspendError: trying to suspend JS frames`                  | either a host callback ran unmasked, or the build lacks `-sSUPPORT_LONGJMP=wasm`                                                                      |
| `ReferenceError: Asyncify is not defined`                    | the shim was not imported, or a bundler tree-shook it. Check `sideEffects` in your bundler config                                                     |
| slicing silently stops happening                             | a leaked mask depth. `createCartridge()` reports it as `interpreter.mask_leaked`; a hand-rolled gate will not                                         |
| the module throws before it instantiates                     | `self.location` is missing on workerd. Import `@drupflare/cartridge/shim` first, for its effect                                                       |
| a wasm compile error only inside a request                   | workerd blocks request-time wasm codegen. The binary must be a module-scope import                                                                    |
| the interpreter ran twice on the first request               | `-sINVOKE_RUN=0` was not set, so instantiation ran `main` before any script was written                                                               |
| memory climbs across warm requests, never falls              | `LAZY_FS_BUDGET_BYTES` is unset or too high. wasm memory never shrinks, so watch the trend                                                            |
| a restored heap throws `RandomException`, or stalls 80-120 s | the open fd table was not reproduced at the same fd numbers. Inode alignment is not the issue; that was tested and falsified                          |
| `materialise()` computes `NaN`                               | a `StreamPackEntry` was handed to the per-file reader. The two index shapes are not interchangeable                                                   |
| `RuntimeError: Aborted('callMain' was not exported...)`      | the raw module went to `instantiate` and the build does not export it. Write the adapter; `createCartridge()` names this `interpreter.no_entry_point` |
| `TypeError: FS.utime is not a function`                      | a mount called it on a build that has none, such as wasmoon. `MountFS.utime` is optional and this package calls it as `utime?.()`                     |
| a WASI write answers `errno 44`                              | the parent directory does not exist. A preopen has no `mkdir -p`; `mkdirp()` creates each segment                                                     |
| one run's last line arrives at the front of the next run     | the build buffers output bytes and flushes on a newline. php-wasm needs `flush()` inside `callMain`                                                   |
