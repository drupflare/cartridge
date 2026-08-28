# 🎮 cartridge

> Run a blocking wasm interpreter inside a Cloudflare Durable Object

[![Build](https://github.com/drupflare/cartridge/actions/workflows/build.yml/badge.svg)](https://github.com/drupflare/cartridge/actions/workflows/build.yml)
[![Interpreters](https://github.com/drupflare/cartridge/actions/workflows/e2e.yml/badge.svg)](https://github.com/drupflare/cartridge/actions/workflows/e2e.yml)
[![Prettier](https://github.com/drupflare/cartridge/actions/workflows/prettier.yml/badge.svg)](https://github.com/drupflare/cartridge/actions/workflows/prettier.yml)
[![codecov](https://codecov.io/gh/drupflare/cartridge/branch/master/graph/badge.svg)](https://codecov.io/gh/drupflare/cartridge)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

cartridge runs a blocking wasm interpreter inside a Cloudflare Durable Object. Pass
`createCartridge()` a wasm module and call `run()`; the reentrancy gate, the interrupt mask and the
filesystem are wired for you. Every piece stays exported for callers that need them directly.

The Workers runtime is asynchronous and a wasm interpreter is not. Two overlapping invocations
share one mutable machine — globals, open file descriptors, session state — and interleave into
plausible wrong output rather than failing.

Nothing here is specific to PHP. Five real builds run through `tests/interpreters/` on every push:
**PHP 8.3** (php-wasm), **Lua 5.4** (wasmoon), **CPython 3** (Pyodide), **QuickJS**
(quickjs-emscripten) and **CRuby 3.4** (ruby.wasm, over WASI rather than emscripten). See
[ADVANCED_USAGE.md](ADVANCED_USAGE.md) for the per-language status and a recipe for each.

---

## 📋 Table of Contents

- [Why Cartridge](#-why-cartridge)
- [Install](#-install)
- [Quick Start](#-quick-start)
- [What Is Here](#-what-is-here)
- [Subpath Exports](#-subpath-exports)
- [Ergonomics](#-ergonomics)
- [Error Handling](#-error-handling)
- [Reentrancy Gate](#-reentrancy-gate)
- [Interrupt Mask](#-interrupt-mask)
- [Filesystem](#-filesystem)
- [Supervisor](#-supervisor)
- [Tail Worker](#-tail-worker)
- [Two Layers](#-two-layers)
- [Testing](#-testing)
- [Related Repositories](#-related-repositories)
- [License](#-license)

---

## 🎯 Why Cartridge

A wasm interpreter is **a single mutable machine**. Globals, the autoloader cache, the container
pointer, open file descriptors and session state are all process-wide. Two overlapping invocations do
not fail loudly. They interleave and produce plausible wrong output.

Cloudflare's runtime is the opposite shape. It is event-driven and it will happily deliver a second
request while the first is parked. Durable Objects narrow that, but do not close it.

So the host has to supply four things the interpreter cannot supply for itself: serialisation, a way
to hold off an interrupt across a host call, a filesystem that does not cost a full inflate at boot,
and a repair path that does not run inside the thing it repairs.

Each is silent when it is missing. An unmasked callback surfaces as `SuspendError` from wherever the
opcode counter happened to land, months later and under load.

---

## 📥 Install

```sh
bun add @drupflare/cartridge
```

Two runtime dependencies, `fflate` and `fzstd`, both synchronous decompressors. A lazy mount
inflates inside a synchronous `open()` from wasm and a pre-compressed interpreter inflates at module
scope; neither point can await `DecompressionStream`, which is also limited to gzip and deflate.

---

## 🚀 Quick Start

```ts
import { createCartridge } from '@drupflare/cartridge';

const cartridge = createCartridge({
  // whatever your build's factory is; forward the io it gives you
  instantiate: (io) => initInterpreter({ print: io.print, printErr: io.printErr }),
  // files every run should see, written once at boot
  files: { 'lib/helper.txt': 'shared by every run' }
});

const result = await cartridge.run('print("hello")');
console.log(result.stdoutText); // "hello\n"
console.log(result.status); // 0
```

That is the default path. Every entry is serialised, every `print` runs masked, the script is
in the filesystem before `callMain` is entered, and a leaked mask depth is reported by name instead
of poisoning the next run.

**What your build has to satisfy** is two members:

```ts
interface Interpreter {
  FS: MountFS; // emscripten's FS: mkdir, writeFile, and optionally utime
  callMain(argv: string[]): number | void;
}
```

which is what emscripten produces for a `main()`-having program built with `-sINVOKE_RUN=0` and
`-sEXPORTED_RUNTIME_METHODS=callMain,FS`. **Most published builds do not do that**: wasmoon, Pyodide,
quickjs-emscripten, ruby.wasm and php-wasm were all checked and none of the five exports `callMain`,
so writing it as a two-line adapter is the normal case rather than the fallback. `createMemoryFS()`
supplies the other half when a build has no filesystem either, and `FS` is three method signatures
rather than emscripten's object, so a WASI preopen satisfies it too. See the recipes in
[ADVANCED_USAGE.md](ADVANCED_USAGE.md), each labelled with what was actually run.

---

## 🧰 What Is Here

| Module           | Lines | What it does                                                                     |
| ---------------- | ----- | -------------------------------------------------------------------------------- |
| `lazy-fs.ts`     | 563   | MEMFS mount that inflates a file on first open, from layered per-file packs      |
| `supervisor.ts`  | 533   | tripwires, the health ledger, the circuit breaker, the repair ladder             |
| `cartridge.ts`   | 460   | `createCartridge()`: the high-level default, and `RunResult`                     |
| `mount.ts`       | 374   | the eager streaming mount, the driver mount, `mountRecord()`, `createMemoryFS()` |
| `tail-worker.ts` | 359   | summarises a Tail Worker's events into something a human reads                   |
| `mask.ts`        | 328   | the refcounted interrupt mask, plus the VM slice counters                        |
| `serialize.ts`   | 142   | `Gate`: one interpreter, one invocation at a time                                |
| `util.ts`        | 150   | `fromUtf8`/`toUtf8`, `encodeJson`/`decodeJson`, `toBytes`, `splitLines`          |
| `errors.ts`      | 119   | the five-name error vocabulary, each with a stable dotted `code`                 |
| `worker-shim.ts` | 72    | makes the emscripten `ENVIRONMENT=worker` build instantiate on workerd           |

---

## 🧭 Subpath Exports

One package, `sideEffects` declared honestly, and a subpath per concern so a bundler can drop what
you do not use.

| Import                            | What is in it                                                        |
| --------------------------------- | -------------------------------------------------------------------- |
| `@drupflare/cartridge`            | everything below except the shim                                     |
| `@drupflare/cartridge/cartridge`  | `createCartridge()`, `RunResult`, `Interpreter`                      |
| `@drupflare/cartridge/gate`       | `Gate`, `doGate`, `GateStats`                                        |
| `@drupflare/cartridge/mask`       | `createMask`, the singleton, `vmFromBinary`, the slice counters      |
| `@drupflare/cartridge/fs`         | both mounts, `mountRecord`, `createMemoryFS`, both pack-index shapes |
| `@drupflare/cartridge/supervisor` | tripwires, `CircuitBreaker`, the ledger DDL                          |
| `@drupflare/cartridge/tail`       | the Tail Worker handler and its pure reducers                        |
| `@drupflare/cartridge/util`       | the byte, string and JSON conveniences                               |
| `@drupflare/cartridge/errors`     | the error vocabulary                                                 |
| `@drupflare/cartridge/shim`       | **side-effectful**; import for effect before the glue evaluates      |

> [!WARNING]
> `sideEffects` is an array rather than `false`. `worker-shim.ts` patches
> `globalThis` at import time; declaring the package side-effect-free would let a bundler tree-shake
> it away, which deletes the `Asyncify` stub and restores an **uncatchable** request kill. Declaring
> `true` would disable shaking for the whole package. The array is the only honest answer, and
> `tests/exports.spec.ts` pins it.

---

## ✨ Ergonomics

**Never build a `TextEncoder` to use this package.** Every payload takes `string | Uint8Array`;
everything that hands bytes back also hands back decoded text.

```ts
import { createCartridge, fromUtf8, toUtf8 } from '@drupflare/cartridge';

const cartridge = createCartridge({ instantiate });

// a string or bytes, both fine
await cartridge.run('print(1)');
await cartridge.run(fromUtf8('print(1)'));

// structured input, no encoder at the call site
await cartridge.writeJson('input.json', { items: [1, 2, 3] });

const result = await cartridge.run('read input.json and print a total');
result.stdout; // Uint8Array, the primitive
result.stdoutText; // string, what you wanted
result.json<{ total: number }>(); // parsed
result.lines(); // ['{"total":6}']
result.lastLine(); // the last line, no trailing empty element
result.assertOk(); // throws InterpreterError naming the status and stderr
```

And the raw path is still there:

```ts
// the module itself, instantiated if needed, handed over inside the gate
const raw = await cartridge.interpreter();

// or run arbitrary work against it, still serialised against every other entry
await cartridge.withInterpreter((module) => module.FS.writeFile('/tmp/x', 'by hand'));
```

Naming is fixed so it is learnable once: `to*`/`from*` for codecs (`toUtf8`, `fromUtf8`), `*Json` for
serialise/parse (`writeJson`, `encodeJson`, `decodeJson`), `*Text` for decoded fields (`stdoutText`),
`.json()` / `.lines()` on a result.

---

## 🔔 Error Handling

Five names, one base, and every one carries a stable dotted `code`. Match on the code, not on the
message text.

| Class                | Default code        | Raised when                                                  |
| -------------------- | ------------------- | ------------------------------------------------------------ |
| `CartridgeError`     | `cartridge.error`   | the base; also the JSON codec refusals                       |
| `GateError`          | `gate.error`        | the gate was misused, or observed two runs at once           |
| `MaskViolationError` | `mask.violation`    | an unbalanced mask, or a suspension attempted while masked   |
| `MountError`         | `mount.error`       | a pack was unreachable, or the FS refused a write            |
| `BudgetError`        | `budget.exceeded`   | a slice, a resident-bytes ceiling or an interrupt allowance  |
| `InterpreterError`   | `interpreter.error` | instantiation, no entry point, a nonzero exit, a leaked mask |

```ts
import { InterpreterError, isCartridgeError } from '@drupflare/cartridge';

try {
  (await cartridge.run(script)).assertOk();
} catch (error) {
  if (error instanceof InterpreterError && error.code === 'interpreter.nonzero_exit') {
    // the script failed, which is different from the interpreter failing
  } else if (isCartridgeError(error)) {
    // something in the cartridge layer; error.code says which seam
  }
}
```

The codes use the same dotted shape as `supervisor.ts`'s `Finding.code`, so a thrown error and a
recorded finding about the same defect correlate without a translation table.

---

## 🚧 Reentrancy Gate

`Gate` serialises entry into the interpreter: one invocation at a time, queued in FIFO order.

Every host call is synchronous today, so nothing overlaps yet. One suspending call — JSPI, an
awaited query, an outbound fetch — is enough for a second request to enter while the first is
parked mid-request.

Two separate mechanisms exist:

| Mechanism                     | Where it works                                   | Why not only this one                                                                     |
| ----------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `Gate`                        | a plain Worker, a Durable Object, `wrangler dev` | portable, and what the tests drive                                                        |
| `ctx.blockConcurrencyWhile()` | a Durable Object only                            | stronger — the runtime stops delivering events — but it caps at 30 s and cannot be nested |

`doGate(gate, ctx)` is the combination, and the order matters: the gate is entered **first** and the
block is taken inside it, never the other way round; `blockConcurrencyWhile` cannot nest.
Pass a `ctx` to `createCartridge()` and you get that automatically.

> [!CAUTION]
> **Acquiring the gate inside a call that already holds it hangs forever**, with no error. `alarm()`
> is not gated as a whole while `fetch()` is, so before adding a gated entry point, check whether
> you are already inside one.

---

## 🎭 Interrupt Mask

`mask.ts` is the piece with the least obvious reason to exist. `_zend_wasm_slice_arm(period)` fires
the VM interrupt on an **opcode counter, not a seam**, and JSPI cannot suspend a stack with a JS
frame in it — `SuspendError: trying to suspend JS frames`. Several host calls put exactly that frame
under the interpreter's stack: the SQL bridge, the codec inside it, the logger, every capability
call, every lazy-FS `inflateSync`, and every `print` callback.

So the interrupt has to be held off for the duration of the host call and released after it. The mask
is **refcounted**, since those calls nest, and it exposes counters so a leak is visible rather than
inferred:

```ts
import { createMask } from '@drupflare/cartridge/mask';

const mask = createMask();

const rows = mask.withMask(() => {
  // any host call that puts a JS frame under the interpreter goes here
  return [];
});

const { enters, nested, maxDepth, deferred, violations } = mask.stats();
```

Four properties, each of which is a way this goes silently wrong without it:

1. **Refcounted.** The cases nest — a host call can trigger a lazy-FS read — and a non-counting
   mask unmasks at the inner exit.
2. **A pending flag that fires on unmask.** `zend_wasm_tick_fired()` skips `EG(vm_interrupt)`
   entirely while masked; it does not defer it, so the boundary is lost unless the host remembers it.
3. **The budget re-checked on unmask**, not only at the poll site. One inflate member is ~1 ms of
   local ratio, so a masked window can overrun a slice on its own.
4. **A dev assertion** that suspension never happens above depth 0. `MaskViolationError` is thrown
   rather than swallowed.

`createCartridge()` gives each cartridge a **fresh** mask rather than the module singleton: two
interpreters in one isolate are two C-side counters, and sharing one host counter would make both
depths wrong. The singleton stays exported for the single-interpreter case the worker uses.

> [!NOTE]
> The depth the host tracks is the **host** depth. The C handler masks itself for the duration of its
> own yield, so `zend_wasm_slice_stat(4)` reads 1 inside a yield and that is correct, not a
> violation. Never assert on it.

---

## 💾 Filesystem

Three mounts, for three different sizes of problem.

| Function                 | For                                               | Cost                                            |
| ------------------------ | ------------------------------------------------- | ----------------------------------------------- |
| `mountRecord()`          | a handful of files you have in hand               | none; a plain `Record<string, string \| bytes>` |
| `mountDrupalStreaming()` | a whole tree, materialised at boot                | one inflate of everything                       |
| `mountDrupalLazy()`      | a whole tree, inflated per file on first `open()` | one resident compressed blob + an LRU           |

`mountRecord()` is the one a first use wants, and `createCartridge({ files })` calls it for you. A
pack is the right answer for an 11,421-file CMS tree and the wrong answer for the three files an
interpreter needs to run one script.

When the build has **no filesystem of its own** — quickjs-emscripten exports none, and a TeaVM or
WASI target has no emscripten `FS` either — `createMemoryFS()` is a `MountFS` over a `Map`, with
`read()` and `readText()` so the adapter never builds a `TextDecoder`. `MountFS.utime` is optional
for the same reason: wasmoon's Lua build ships a real emscripten `FS` and no `utime` at all, and only
`mountDrupalStreaming()` ever calls it.

The lazy mount attacks cold start, measured at 3,754 ms of `cpuTime`
and **3,066 ms of that was the mount**. Layers merge in order, so a driver or a patch can shadow a
base pack without either being rebuilt, and `InflateStats` reports what was actually inflated — which
is the measurement that says whether laziness paid.

> [!IMPORTANT]
> **`StreamPackEntry` and `PerFilePackEntry` are not one type and must not be merged.** `o` means
> different things: the streaming index offsets into the INFLATED concatenation `core.bin.gz`
> produces, the per-file index offsets into the COMPRESSED blob and needs `c` beside `l`. One
> interface covering both would give `o` two meanings and make `c` optional for `materialise()`,
> which computes `blob.subarray(e.o, e.o + e.c)` and would get `NaN`.

Two further behaviours:

- **Layers merge BEFORE node creation**, so a later layer overrides an earlier one on the same path.
- **Heap restore depends on the open file-descriptor table, at the same fd numbers.** Inode alignment
  does **not** matter: that was measured and falsified (shifting every inode by 1 and by 500 both
  restored byte-identically). Dropping `/dev/urandom`'s fd alone throws; dropping sqlite's fds gives
  a locking-protocol error after an **80-120 second stall**, which on an edge runtime is a hung
  request, not an error. If you touch the mount or the snapshot path, that is the invariant.

An R2-backed layer costs **zero subrequests**, making R2 the right store for a mutable layer.

---

## 🩺 Supervisor

`supervisor.ts` holds the half of a health layer that must be JavaScript: **a repair path must not
depend on the subsystem it repairs.**

The interpreter cannot observe a JS throw out of a wasm import — measured twice, `@` and a `catch`
are both useless and the whole invocation dies — cannot observe its own isolate being killed, and
cannot be trusted to fix itself once poisoned. So detection and repair for those classes live out
here.

**Every tripwire corresponds to a defect this project has already shipped and then found.** That is
the selection criterion, and each one names its incident. A check nobody has seen fire is decoration.

The breaker decays rather than looping: the same code N times inside a window escalates one rung on
the ladder, a clean interval decays one rung, and bounded attempts halt with a named reason.

```ts
import {
  CircuitBreaker,
  quarantineDecision,
  runHostTripwires
} from '@drupflare/cartridge/supervisor';

const findings = runHostTripwires({ status: 200, bytes: 0, path: '/' });
const { quarantine, reason } = quarantineDecision(findings);
// quarantine === true, reason === 'render.empty: 200 with 0 bytes'
```

**Quarantine beats wrong output.** A 503 with `Retry-After` is a better answer than a 0-byte 200, and
this project has shipped the 0-byte 200 — then cached it, then served it from the edge.

---

## 📡 Tail Worker

`wrangler tail` reports CPU only while an operator is attached. A Tail Worker receives the same
trace events from inside the platform, continuously and with no operator present.

It also carries the **canary**. The CPU-attribution result the whole slicing design rests on is
undocumented behaviour: work parked in one Durable Object invocation and resumed in another is
charged to the **resuming** invocation. If Cloudflare changes that, nothing in the product fails
loudly — renders just stop fitting. So `evaluateCanary()` re-checks the invariant, with thresholds as
**ratios** rather than milliseconds. Absolute `cpuTime` varies by colo (a render that was
46 ms on one deploy was 75 ms on another).

---

## 🏗 Two Layers

The sibling library `edgeport` uses a two-layer rule: a private `src/core/` is the only code
importing the platform primitive, and every public module builds on it. That rule does not transfer
here.

**cartridge imports nothing from the platform.** `grep -rn "from 'cloudflare" src/` returns nothing.
The primitive it is about — an emscripten `Module` with an `FS` — is instantiated by the **consumer**
and handed in through `instantiate`, and the Durable Object state arrives as an optional
`BlockingContext` with one method on it. So the invariant the two-layer split exists to protect is
already satisfied by there being no platform import to contain.

What does transfer, and is applied: subpath exports from one package, an honest `sideEffects`
declaration, a uniform error vocabulary, ergonomics with an escape hatch, and recipes each backed by
a green spec.

---

## 🧪 Testing

```sh
bun run typecheck
bun run test # in workerd
bun run test:coverage
bun run test:interpreters # 33 assertions against real wasm builds, in node
```

**305 passing, 82% of statements.** The gate runs under `@cloudflare/vitest-pool-workers`, so it
executes inside **workerd** rather than Node, and coverage uses `provider: 'istanbul'` rather than
`v8`. That is a runtime fact, not a preference: the v8 provider reads coverage off the Node
inspector, and these tests run inside workerd's isolate, so it attributes zero while every test
passes.

Four brackets, and each one is honest about what it can prove:

| Bracket                     | Where                                                    | Proves                                              |
| --------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| behaviour over a fake       | most specs                                               | the contract, without a 40 MB binary in the way     |
| the real platform primitive | `mount.spec.ts` (real gzip, real `Response`, `Fetcher`)  | the inflate-and-write path end to end               |
| source assertions           | `lazy-fs.spec.ts`, part of `mask.spec.ts`                | invariants no fake can reach into                   |
| a real wasm interpreter     | `tests/interpreters/` (PHP, Lua, CPython, QuickJS, Ruby) | that a published build satisfies `{ FS, callMain }` |

That last lane is the only thing that makes `ADVANCED_USAGE.md` say **Verified**. Its five builds are
pinned `devDependencies` so renovate bumps them, and `e2e.yml` runs it on every push with a guard
that fails if zero tests ran or any was skipped: a silently skipped lane reads as a pass.

`lazy-fs.ts` has low line coverage (~11%). `mountDrupalLazy()` patches MEMFS node internals,
borrowing `stream_ops` off a probe node the runtime made, so driving it needs a real emscripten
build rather than a fake. Its invariants are pinned by source assertions instead.

---

## 🔗 Related Repositories

| Repository                                                          | What it is                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`drupflare/worker`](https://github.com/drupflare/worker)           | the consumer: Drupal 11 on Cloudflare Workers                            |
| [`drupflare/durabledb`](https://github.com/drupflare/durabledb)     | imports `/gate` and `/mask` for its SQL bridge                           |
| [`drupflare/phasm`](https://github.com/drupflare/phasm)             | builds the interpreter, including the VM interrupt patch the mask drives |
| [`drupflare/stream-http`](https://github.com/drupflare/stream-http) | the PHP-side `https://` stream wrapper, over an injected fetch           |
| [`drupflare/untarl`](https://github.com/drupflare/untarl)           | tar and tar.gz extraction with no Node APIs                              |

---

## 📄 License

MIT (c) Gregory Mitchell 2026. See [LICENSE](LICENSE).
