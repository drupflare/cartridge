import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import * as cartridgeModule from '../src/cartridge.js';
import * as errorsModule from '../src/errors.js';
import * as fsModule from '../src/fs.js';
import * as indexModule from '../src/index.js';
import * as maskModule from '../src/mask.js';
import * as serializeModule from '../src/serialize.js';
import * as supervisorModule from '../src/supervisor.js';
import * as tailModule from '../src/tail-worker.js';
import * as utilModule from '../src/util.js';

/**
 * The subpath map, checked against the modules it names.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW ITEM. An `exports` map is the one part of a package that
 * nothing else in the repo reads: `tsc` resolves relative specifiers, vitest resolves relative
 * specifiers, and the map is only exercised the first time a CONSUMER installs the package. So a
 * typo in it is invisible until publication, which is the worst possible moment. This spec closes
 * that by asserting the map's targets against modules imported here by relative path.
 *
 * `node:fs` does not exist in workerd, so the file cannot be stat'd; importing each target and
 * matching the string is the check that works in this lane, and it proves the same thing -- a target
 * naming a file that does not exist would fail this file's own imports.
 */

/** each public subpath, its declared target, and a symbol that must be reachable through it */
const SUBPATHS: Array<[string, string, Record<string, unknown>, string]> = [
	['.', './src/index.ts', indexModule, 'createCartridge'],
	['./cartridge', './src/cartridge.ts', cartridgeModule, 'createCartridge'],
	['./errors', './src/errors.ts', errorsModule, 'CartridgeError'],
	['./fs', './src/fs.ts', fsModule, 'mountRecord'],
	['./gate', './src/serialize.ts', serializeModule, 'Gate'],
	['./mask', './src/mask.ts', maskModule, 'createMask'],
	['./supervisor', './src/supervisor.ts', supervisorModule, 'runHostTripwires'],
	['./tail', './src/tail-worker.ts', tailModule, 'summarize'],
	['./util', './src/util.ts', utilModule, 'fromUtf8']
];

describe('the package exports map', () => {
	it.each(SUBPATHS)('%s resolves to %s and exposes %s', (subpath, target, module, symbol) => {
		expect((pkg.exports as Record<string, string>)[subpath]).toBe(target);
		expect(module[symbol]).toBeDefined();
	});

	it('declares every source module, so nothing public is unreachable by subpath', () => {
		const targets = Object.values(pkg.exports as Record<string, string>);
		// worker-shim is reached through ./shim and package.json through ./package.json; every other
		// file under src/ has to be named by one of the entries above
		expect(targets).toContain('./src/worker-shim.ts');
		expect(targets).toContain('./package.json');
		// lazy-fs and mount are deliberately NOT their own subpaths: they are one choice, made once,
		// and ./fs is the barrel that puts the two pack-index shapes side by side
		expect(targets).not.toContain('./src/lazy-fs.ts');
		expect(targets).not.toContain('./src/mount.ts');
	});

	it('keeps main and types pointing at the root entry', () => {
		expect(pkg.main).toBe('./src/index.ts');
		expect(pkg.types).toBe('./src/index.ts');
		expect((pkg.exports as Record<string, string>)['.']).toBe(pkg.main);
	});

	it('declares the shim as the ONLY side effect', () => {
		// `sideEffects: false` would let a bundler tree-shake worker-shim away, which deletes the
		// Asyncify stub and restores an uncatchable throw. `true` would disable shaking for the whole
		// package. The array is the only honest answer
		expect(pkg.sideEffects).toEqual(['./src/worker-shim.ts']);
	});

	it('ships src, the licence and both docs, and nothing else', () => {
		expect(pkg.files).toEqual(['src', 'LICENSE', 'README.md', 'ADVANCED_USAGE.md']);
	});

	it('is in the 0.x beta window the rest of the project sits in', () => {
		expect(pkg.version).toMatch(/^0\./);
	});

	it('keeps the single runtime dependency single', () => {
		// one dependency is a promise the README makes; a second one arriving unnoticed is what this
		// pins. fflate is here because inflateSync must run inside a synchronous open() from wasm
		expect(Object.keys(pkg.dependencies)).toEqual(['fflate']);
	});
});

describe('the two test lanes', () => {
	/**
	 * WHY package.json AND NOT vitest.config.ts. The config imports
	 * `@cloudflare/vitest-pool-workers`, which cannot load inside workerd, so this lane cannot read
	 * it. The scripts are the part a human runs and CI runs, and they are the part that rots.
	 */
	it('keeps the gate on the unit project alone', () => {
		// a bare `vitest run` would drag the interpreters project into every gate, and that project
		// carries ~296 MB of wasm across six devDependencies
		expect(pkg.scripts.test).toContain('--project=unit');
		expect(pkg.scripts['test:coverage']).toContain('--project=unit');
	});

	it('gives the real-build verification its own script', () => {
		// ADVANCED_USAGE.md labels a language Verified on the strength of that lane alone, and a lane
		// with no way to run it is a label with nothing behind it
		expect(pkg.scripts['test:interpreters']).toBe('vitest run --project=interpreters');
	});

	it.each([
		'wasmoon',
		'pyodide',
		'quickjs-emscripten',
		'@ruby/wasm-wasi',
		'@ruby/3.4-wasm-wasi',
		'@bjorn3/browser_wasi_shim',
		'php-wasm'
	])('pins %s as a devDependency, where renovate can see it', (name) => {
		/**
		 * WHY THE PIN LIVES IN package.json AND NOWHERE ELSE. A version inside a shell script, a
		 * curl URL or a workflow `env:` is invisible to renovate's built-in managers, so it never
		 * gets a bump PR and rots silently until a recipe breaks. `edgeport` solves the same
		 * problem the same way for its integration servers -- every image pinned to a tag and a
		 * digest in `docker/compose.yml`, which renovate's docker-compose manager reads natively,
		 * and its `renovate.json` carries no customManagers for it. These are npm packages rather
		 * than images, so the npm manager is the one that applies and `devDependencies` is where
		 * it looks.
		 *
		 * A devDependency is never installed for a consumer of this package, so the ~296 MB costs
		 * a contributor and CI, and costs nothing at the seam this package exists to fit.
		 */
		const dev = pkg.devDependencies as Record<string, string>;
		expect(dev[name]).toMatch(/^\^?\d/);
	});
});

describe('the root entry', () => {
	it('re-exports every public module', () => {
		for (const [, , module] of SUBPATHS) {
			for (const name of Object.keys(module)) {
				if (name === 'default') continue;
				expect(indexModule).toHaveProperty(name);
			}
		}
	});

	it('does NOT re-export the shim, so importing the root has no side effect', () => {
		// the shim's only export is `{}`; what would leak is its module-scope patching of globalThis
		expect(indexModule).not.toHaveProperty('__cfwAsyncifyCalls');
	});

	it('resolves MaskViolationError to one class despite two star re-exports', () => {
		// errors.ts declares it and mask.ts re-exports it, so both `export *` lines carry the name.
		// Two DECLARATIONS with one name would make it ambiguous and drop it from the root entry
		expect(indexModule.MaskViolationError).toBe(errorsModule.MaskViolationError);
		expect(indexModule.MaskViolationError).toBe(maskModule.MaskViolationError);
	});
});
