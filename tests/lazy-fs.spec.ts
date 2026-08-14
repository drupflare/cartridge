import { describe, expect, it } from 'vitest';
import { _mergeLayerIndexes, _normaliseLayers } from '../src/lazy-fs.js';
import lazyFsSource from '../src/lazy-fs.ts?raw';
import mountSource from '../src/mount.ts?raw';

/**
 * `mountDrupalLazy()` needs a real emscripten `FS` and a real `env.ASSETS`, neither of which
 * exists in this lane, so these are source assertions -- the same bracket
 * `mask.spec.ts` uses on this module and for the same reason.
 *
 * What they pin is a defect that shipped: the lazy mount fetched `site.sqlite`
 * UNCONDITIONALLY while the streaming mount had already been given an opt-out. That is 6.47 MB
 * and one of the 50 subrequests an invocation gets, spent on a file the shipping binary cannot
 * open -- it has no `pdo_sqlite`, and the only consumer was the PHP migration engine that the
 * JavaScript chunked replay replaced.
 *
 * It mattered more than a stray fetch because `LAZY_MOUNT=1` is the flag that is supposed to
 * remove boot cost. The one cost it did not remove was this one.
 *
 * Assertions are quote-agnostic and whitespace-tolerant on purpose: an earlier source
 * assertion in this repo hardcoded double quotes and reported a phantom wiring failure the
 * moment prettier switched the repo to single ones.
 */

/** the region of a source file between two markers, so an assertion cannot match elsewhere */
function between(source: string, from: string, to: string): string {
	const start = source.indexOf(from);
	const end = source.indexOf(to, start + 1);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe('the lazy mount does not fetch a database nobody can open', () => {
	it('gates the site.sqlite fetch behind an explicit opt-in', () => {
		const region = between(lazyFsSource, 'const wantDatabase', 'const blobs =');
		// `=== true` not `!== false`: the default must be to SKIP, which is the whole fix
		expect(/const wantDatabase\s*=\s*opts\.database\s*===\s*true/.test(region)).toBe(true);
		expect(/wantDatabase\s*\n?\s*\?\s*env\.ASSETS\.fetch/.test(region)).toBe(true);
	});

	it('keeps the site.sqlite fetch out of the unconditional Promise.all entries', () => {
		// the pack fetch moved into fetchLayer() when layers landed, so the two fetches that are
		// always made now live there; what must stay true here is that site.sqlite is reached
		// ONLY through the wantDatabase ternary
		const region = between(lazyFsSource, 'const [layerData, dbRes]', 'const blobs =');
		const sqliteAt = region.indexOf('site.sqlite');
		const ternaryAt = region.indexOf('wantDatabase');
		expect(ternaryAt).toBeGreaterThan(-1);
		expect(sqliteAt).toBeGreaterThan(ternaryAt);
		// and the layer fetch is unconditional, which is what makes the pack always present
		expect(region).toContain('layers.map((l) => fetchLayer(l, env))');
		expect(
			between(lazyFsSource, 'async function fetchLayer', 'export function _merge')
		).toContain('core.pf.bin');
	});

	it('reports the subrequest it actually spent, rather than a constant', () => {
		// this project's own rule: an instrument that reports a cost it did not pay is worse
		// than no instrument. The count has to follow the flag
		// the count is derived from the layer list now, not a constant, because an R2 layer
		// costs no subrequest at all
		expect(/layers\.filter\(\(l\) => !l\.r2\)\.length \* 2/.test(lazyFsSource)).toBe(true);
		expect(/subrequests:\s*3\s*,/.test(lazyFsSource)).toBe(false);
	});

	it('still writes the database into MEMFS when it was asked for', () => {
		// the opt-out must not have removed the capability, only the default
		const region = between(lazyFsSource, 'let dbBytes = 0;', 'return {');
		expect(/if\s*\(dbRes\.ok\)/.test(region)).toBe(true);
		expect(region).toContain('FS.writeFile');
	});
});

// the companion assertion -- that site-do.ts passes ONE condition to both call sites -- stays in
// the worker, because site-do.ts is the product and did not come with the split
describe('the streaming mount answers the database question too', () => {
	it('has the streaming mount default to skipping it too', () => {
		expect(/const wantDatabase\s*=\s*opts\.database\s*!==\s*false/.test(mountSource)).toBe(
			true
		);
	});
});

describe('N layers, which is what makes runtime module install possible', () => {
	it('treats a bare prefix as one layer, so the old behaviour is unchanged', () => {
		expect(_normaliseLayers({})).toEqual([{ prefix: 'drupal-pf', name: 'drupal-pf' }]);
		expect(_normaliseLayers({ prefix: 'drupal-trim' })).toEqual([
			{ prefix: 'drupal-trim', name: 'drupal-trim' }
		]);
	});

	it('names an R2 layer from its key when no name is given', () => {
		const out = _normaliseLayers({ layers: [{ prefix: 'core-pf' }, { r2: 'modules' }] });
		expect(out.map((l: { name: string }) => l.name)).toEqual(['core-pf', 'modules']);
	});

	it('lets `layers` win over `prefix`, rather than silently merging the two', () => {
		const out = _normaliseLayers({ prefix: 'ignored', layers: [{ r2: 'only' }] });
		expect(out).toHaveLength(1);
		expect(out[0]?.r2).toBe('only');
	});

	it('tags every entry with the layer it came from', () => {
		const merged = _mergeLayerIndexes([
			{ index: [{ p: 'a.php', o: 0, c: 1, l: 1 }] },
			{ index: [{ p: 'b.php', o: 0, c: 1, l: 1 }] }
		]);
		expect(merged.map((e) => [e.p, e.__layer])).toEqual([
			['a.php', 0],
			['b.php', 1]
		]);
	});

	it('lets a LATER layer override an earlier one on the same path', () => {
		// the direction is the whole point: a modules layer exists to add and replace files on
		// top of core, and the previous code swallowed the collision with a `continue`, which
		// would have made core win
		const merged = _mergeLayerIndexes([
			{ index: [{ p: 'x.php', o: 0, c: 10, l: 10 }] },
			{ index: [{ p: 'x.php', o: 99, c: 20, l: 20 }] }
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.__layer).toBe(1);
		expect(merged[0]?.o).toBe(99);
	});

	it('refuses an absolute or empty path from any layer', () => {
		const merged = _mergeLayerIndexes([
			{
				index: [
					{ p: '/etc/passwd', o: 0, c: 1, l: 1 },
					{ p: '', o: 0, c: 1, l: 1 },
					{ p: 'ok.php', o: 0, c: 1, l: 1 }
				]
			}
		]);
		expect(merged.map((e) => e.p)).toEqual(['ok.php']);
	});

	it('handles an empty or missing index without throwing', () => {
		expect(_mergeLayerIndexes([])).toEqual([]);
		expect(_mergeLayerIndexes([{ index: [] }])).toEqual([]);
	});

	it('counts subrequests per ASSETS layer and none for R2', () => {
		// R2 costing no subrequest is the meter that made it the right store for a mutable pack
		const src = lazyFsSource.slice(lazyFsSource.indexOf('subrequests:'));
		expect(/layers\.filter\(\(l\) => !l\.r2\)\.length \* 2/.test(src)).toBe(true);
	});
});
