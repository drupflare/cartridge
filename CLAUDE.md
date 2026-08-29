# cartridge

Generic plumbing for running a **blocking wasm interpreter inside a Cloudflare Durable Object**.
Extracted from `drupflare/worker`, where it ran PHP 8.3 as wasm serving Drupal 11, but nothing here
knows what PHP is.

Two layers of surface: `createCartridge()` is the high-level default that hides the gate, the mask and
the mount, and every raw piece stays exported for a caller who needs to drive them.

## Status

**Published.** `@drupflare/cartridge@0.2.0` is on npm, with subpath exports and an honest
`sideEffects` array. `release.yml` tags, releases and publishes to npm and to GitHub Packages, so a
release is the whole release rather than half of it. The release sequence is maintainer-only.

**`NPM_TOKEN` has to exist as a repository secret** or the publish job stops at "Check the Token Is
Present" with a named error. That guard is loud rather than skipping on purpose: npm has no
tag-driven mechanism the way Packagist does, so a release that quietly skips the publish produces a
version that exists on GitHub and nowhere a consumer can install it. `registry-url` on the
`setup-node` step is what makes `NODE_AUTH_TOKEN` readable at all - without it the publish runs
anonymously and npm answers **404**, not 401, which is the most misread error in the process.

**The GitHub Packages half was silently broken by the same mechanism, one host over.** `setup-node`
writes ONE host-scoped credential line, `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`, and
npm matches `_authToken` by registry host. So `npm publish --registry https://npm.pkg.github.com`
carried no credential no matter what `NODE_AUTH_TOKEN` was set to in that step's `env`, and the
result was swallowed by a `||` that reported every failure as "most likely already present" and
exited 0. There is now a second `setup-node` with `registry-url: https://npm.pkg.github.com` and
`scope: '@drupflare'`, an existence check symmetric with the npm one, and a bare `npm publish` that
is allowed to fail the job. **Never route a publish at another registry with `--registry` alone**;
give that host its own `setup-node`, and never wrap a publish in `||`.

`drupflare/durabledb` consumes `./gate` and `./mask` from the registry at `^0.2.0`, with no `paths`
mapping and no `resolve.alias` left; two specs in its `tests/exports.spec.ts` hold that down, because
**an alias silently wins over `node_modules`** and in CI, where the sibling checkout does not exist,
the mapping falls through and both lanes agree again - which makes the divergence a property of the
machine rather than of the code. `durabledb` is green against the published package: `bun run
typecheck` clean, 124 assertions passing.

`drupflare/worker` still has its own copies of these modules under `src/runtime/` and there is **no
sync check** for duplicated TypeScript the way there is for duplicated PHP. That is the reason to
adopt the package, and the reason to do it as its own change.

## The things that are load-bearing and non-obvious

**The gate exists because the gate is already held.** `alarm()` is not gated as a whole while
`fetch()` is. Acquiring the gate a second time inside a call that already holds it hangs **forever**,
and it presents as a deadlock while actually being starvation. A failing step that re-armed at +1 ms
once spun an object forever and starved every gated request past 90 s. Nothing threw.

**Never a fixed retry loop.** The breaker decays: the same failure code N times in M minutes
escalates, a clean interval decays one level, then bounded attempts halt with a **named** reason.

**Heap restore depends on the open file-descriptor table, at the same fd numbers.** Inode alignment
does NOT matter - that was measured and falsified (shifting every inode by 1 and by 500 both restored
byte-identically). Dropping `/dev/urandom`'s fd alone throws; dropping sqlite's fds gives a
locking-protocol error after an **80-120 second stall**, which on an edge runtime is a hung request,
not an error. If you touch the mount or the snapshot path, this is the invariant.

**`lazy-fs` merges layers BEFORE node creation.** Later layers override earlier ones on the same
path. The earlier implementation swallowed the collision with a `continue`, which made the base layer
win - backwards for an overlay. An R2-backed layer costs **zero subrequests**, which is why R2 is the
right store for a mutable layer.

**`callMain` goes OUTSIDE the mask, and this is the easiest thing to get backwards.** The mask exists
to hold the interrupt off across a HOST call that puts a JS frame under the interpreter. The
interpreter's own execution is the stack a slice is supposed to be able to interrupt, so masking
`callMain` silently disables slicing - and the dev assertion that would catch it never fires, because
the suspension never comes. `src/cartridge.ts` masks `print`/`printErr` and not `callMain`, with the
reason inline at both sites.

**`createCartridge()` uses a FRESH mask, not the module singleton.** Two interpreters in one isolate
are two C-side counters; one shared host counter would make both depths wrong. The singleton stays
exported for the single-interpreter case the worker uses.

**`sideEffects` is an ARRAY, not `false`.** `worker-shim.ts` patches `globalThis` at import time.
Declaring the package side-effect-free would let a bundler tree-shake it away, which deletes the
`Asyncify` stub and restores an uncatchable request kill. Declaring `true` would disable shaking for
the whole package. `tests/exports.spec.ts` pins the array.

## The two pack index shapes, which are NOT one type

`mount.ts` reads `core.json` and `lazy-fs.ts` reads `core.pf.json`, and the two were both called
`PackEntry` until the split put them in one package. They are now `StreamPackEntry` and
`PerFilePackEntry`, and they stay separate because **`o` means different things**: the streaming index
offsets into the INFLATED concatenation `core.bin.gz` produces, the per-file index offsets into the
COMPRESSED blob and needs `c` beside `l`. Merging them would give one field two meanings and make `c`
optional for `materialise()`, which computes `blob.subarray(e.o, e.o + e.c)` and would get `NaN`. Do
not "simplify" them back into one. `src/fs.ts` is the barrel that puts them side by side for exactly
this reason.

## Test disposition, and the rule that governs it

`tests/_needs-rewrite/` is **gone**. Every spec that was parked or degraded during the extraction is
resolved:

| Spec                       | Verdict                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `serialize.spec.ts`        | moved whole, byte-identical apart from the import path; `doGate`'s delegating wrappers now covered too   |
| `lazy-fs.spec.ts`          | moved minus one `it` that reads the worker's own `site-do.ts?raw`; that `it` still runs in `worker`      |
| `mask.spec.ts`             | moved minus the SQL-bridge describe                                                                      |
| `do-sqlite-bridge.spec.ts` | moved to `durabledb`, folded into `tests/do-sqlite.spec.ts`, assertions unchanged, import specifier only |

**Do not weaken an assertion to make a spec pass.** The originals still run in `worker`, so a weakened
copy here would look like coverage while proving less than the thing it replaced. If a spec cannot pass
without weakening, that is a finding to report with file:line, not a thing to soften.

One correction worth keeping, because it was believed and acted on: an earlier note claimed `doGate`
was parked because it needed `cloudflare:test` and the worker's `SiteDurableObject`. **That was wrong.**
`doGate()` takes a plain `BlockingContext`, the describe builds one as an object literal, and the file
imports nothing but `vitest` and the module under test. Dropping it would have opened a coverage hole
on a shipped function on the strength of a guess.

## Coverage

`bun run test:coverage` reports **99.38% of statements** (811/816) over 382 assertions, every source
file at or above 98%. Branches are 91.04%, with `worker-shim.ts` and `tail-worker.ts` carrying most
of what is left.

**`lazy-fs.ts` was recorded here as structurally stuck near 11%, and that is falsified.** The claim
was that `mountDrupalLazy()` patches MEMFS node internals and borrows `stream_ops` off a probe node,
so driving it needed a real emscripten build rather than a fake. `lazy-fs.spec.ts` builds the fake
and drives the function end to end; the module measures 136/136 statements. Do not reinstate the
ceiling without a measurement.

The ASSETS-backed mounts are driven **for real** - workerd has `Response`, `CompressionStream` and
`DecompressionStream`, so a fake `Fetcher` over a real gzip member exercises the whole
inflate-and-write path.

`codecov.yml` targets 97%, set just under the measured number rather than from a guess.

## Conventions

- `bunx`, never `npx`.
- Imports use a `.js` specifier even for `.ts` files. bun resolves this; `node` does not.
- One runtime dependency: `fflate`. Keep it that way unless there is a measured reason.
  `tests/exports.spec.ts` fails if a second one appears.
- Errors come from `src/errors.ts` and carry a stable dotted `code`. Do not throw a bare `Error` from
  a public path, and do not let a caller have to match on a message string.
- Every public API that takes a payload takes `string | Uint8Array`; everything that returns bytes
  also returns decoded text. No caller of this package should ever build a `TextEncoder`.
- Comments: lowercase, terse, one line, no trailing period, only where the WHY is non-obvious.
- Every behaviour change ships with its test in the same change, and one spec file per domain - fold
  a new case into the existing spec rather than adding a parallel `*-extra.spec.ts`.

## Documentation honesty rule

`ADVANCED_USAGE.md` carries exactly TWO labels and there is no third: **Verified** means a test in
`tests/interpreters/real-builds.spec.ts` installs that build from npm, drives it through this package
and passes. Everything else is **Not verified**. A language moves to Verified only when a test in that
lane is green, never on the strength of a reading; **do not invent an `emcc` line you have not run**,
and do not let Verified imply a Worker fits the build - Pyodide satisfies the contract and its wasm
alone is 9.6 MB against a 3 MB gzipped ceiling, CRuby's is 30 MB.

**PHP holds two rows and they carry different labels.** php-wasm 0.1.0 is Verified: the lane installs
it, drives PHP 8.3 through `pib_run` and passes. The build in `drupflare/worker` is a different
artifact, exports `{ FS, callMain }` directly, runs on a deployed Worker, and stays Not verified
because nothing here drives it. Neither row is evidence for the other; do not merge them.

**Java is Verified, and what that covers is arranged differently from the other five.**
`@gmitch215/bytebox` 1.0.0 compiles Java to WasmGC through TeaVM and publishes the LOADER; npm ships
no runtime, so the lane installs the loader and carries the program itself as a committed 19 KB
`tests/fixtures/java.wasm`. The package sits in `REQUIRED`, so an absent install turns CI red like
any other. Do not re-run the old search (`teavm`/`cheerpj` unpublished, `doppiojvm` 2016 and
TypeScript); it has been answered.

Java is also the only **compiled** language here, which is why its recipe inverts the boot order:
`load()` compiles wasm, a Worker permits that only during module evaluation, so the module is built
at module scope and the collectors are rebound per `instantiate`. Do not "consistency-fix" it to
boot inside `instantiate`. One `load()` serves one cartridge; a second overwrites `io` and
cross-wires both cartridges' output.

`tests/fixtures/java.wasm` and `java.wasm-runtime.js` are build output committed as test input, so
two rules hold. `*.wasm binary` in `.gitattributes` keeps `* text eol=lf` from normalising the
module, and `.prettierignore` covers the runtime because it is TeaVM's minified emission and
formatting it destroys the byte-identity a rebuild is diffed against.

bash and Perl are still absent with nothing to install: `webperl`, `bash-wasm`, `wasm-bash` and
`busybox-wasm` are all 404 on npm.

What the six real builds measured, because it is a finding about the contract and not about them:
**none of wasmoon, Pyodide, quickjs-emscripten, ruby.wasm, php-wasm or bytebox exports `callMain`.**
The edge PHP does, having been built to. So the `main()` recipe is the exception, the two-line adapter
is the normal case, and `MountFS.utime` is optional because wasmoon's real emscripten FS has none.

**`callMain` was widened to `number | void | Promise<number | void>` and `execute()` awaits it.** The
Java adapter is the reason: `main` returning is not the program finishing, because a Java thread on
this target is a fiber on the host queue and draining it is asynchronous. With the old signature
`Number(callMain(argv) ?? 0)` turned a promise into `NaN`, so the adapter had to call the synchronous
drain and discard its result -- a run stopped by the fiber budget reported status 0 and its
continuation printed into whatever run was current later. That is the interleave this package exists
to prevent, arriving through the adapter. Both recipe specs for it are in `recipes.spec.ts`. Reading
an unexported member can also **throw** - emscripten swaps in a getter that calls `abort()` - so
`_entryPointProblem()` guards the read. **`MountFS` is three method signatures, not a reference to
emscripten's object**, so a WASI preopen directory satisfies it: the Ruby describe mounts through
`@bjorn3/browser_wasi_shim`'s `PreopenDirectory` in ten lines, and that is why the contract is not
emscripten-only.

## Measurement discipline inherited from the parent project

If you measure anything about CPU on Cloudflare: an absolute figure comes only from `cpuTime` in
`wrangler tail` on a **deployed** worker. `Date.now()` inside the isolate returns 0 on the edge - or a
plausible wrong number, measured at 114 ms for a 1,374 ms invocation - and a local wall clock could not
even ORDER two profiles correctly. Five of six moved verdicts in the parent project moved because the
instrument was wrong, not the system.

## Commands

```sh
bun run typecheck
bun run test # 382 assertions across 14 specs, in workerd and node
bun run test:coverage
bun run test:interpreters # 40 assertions against real wasm builds, in node
bunx prettier --check .
```

**Three vitest projects, and `bun run test` is `unit` plus `node`.** `interpreters` runs under node
because wasmoon, Pyodide, quickjs-emscripten, ruby.wasm and php-wasm each reach for their own wasm
off disk and none of that is reachable from workerd; php-wasm's `PhpNode` also statically imports
`node:fs`. A bare `vitest run` would drag ~296 MB of wasm into every gate, so the gate names its
projects.

**`node` exists because a project the coverage runner never selects reads as untested code.**
`tests/node/inflate-compile.spec.ts` was under `tests/interpreters/`, which `test:coverage` does not
run, so `zstdDecoderFromWasm` reported 0 lines covered while having passing tests -- the same shape
that produced two false 0% verdicts in the `rom` sibling. It needs node only for wasm codegen, not
for an interpreter download, so it belongs in a lane the gate and coverage both run.
`tests/exports.spec.ts` now enumerates the projects out of `vitest.config.ts?raw` and fails when one
of them is in no `test*` script, or when a gated project is missing from `test:coverage`.

**Every interpreter is a pinned `devDependency`, and that placement is the point.** It is the only
place renovate's npm manager can see a version; one buried in a shell script or a workflow `env:`
gets no bump PR and rots silently. `edgeport` does the same thing for its integration servers with
tag+digest pins in `docker/compose.yml`, read natively by the docker-compose manager, with no
`customManagers` entry - so cartridge needs none either. A devDependency is never installed for a
consumer, so the cost (~18 MB for the first three, ~94 MB for `@ruby/3.4-wasm-wasi`, which ships a
debug build alongside the two it uses, and ~182 MB for `php-wasm`, which ships twelve wasm builds and
has no per-version sub-package) falls on a contributor and CI and nothing at the seam this package
fits.

**The interpreters lane cannot statically import `node:*` or use `WebAssembly.compile`.** The single
tsconfig has `types: ["@cloudflare/workers-types"]`, which models workerd: `WebAssembly.Module` is
declared abstract and there is no `compile`. `real-builds.spec.ts` reaches both through local casts
rather than an ambient widening, so the guard keeps holding for `src/`.
