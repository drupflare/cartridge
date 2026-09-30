import { deflateSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_mergeLayerIndexes,
	_normaliseLayers,
	mountDrupalLazy,
	type LazyBinary,
	type LazyFS,
	type LazyMountOptions,
	type LazyNode,
	type LazyStream,
	type MemfsNode,
	type MemfsStreamOps,
	type PerFilePackEntry
} from '../src/lazy-fs.js';
import lazyFsSource from '../src/lazy-fs.ts?raw';
import { maskDepth, maskStats, resetMask } from '../src/mask.js';
import mountSource from '../src/mount.ts?raw';
import { toUtf8 } from '../src/util.js';

/**
 * A few assertions here are on the SOURCE rather than on behaviour, and that bracket is now the
 * exception rather than the rule -- `mountDrupalLazy()` is driven end to end below over a fake
 * MEMFS, the same instrument `mount.spec.ts` uses for the streaming mount.
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

	it('falls back to a positional name when a layer names nothing at all', () => {
		// `{}` is a legal LayerSpec and a caller writing one by hand gets it; without the
		// fallback the layer reports `undefined` in the mount result's `layers` array
		expect(_normaliseLayers({ layers: [{}, {}] }).map((l) => l.name)).toEqual([
			'layer0',
			'layer1'
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

	it('never tags an entry with a layer outside the list it was given', () => {
		/**
		 * The invariant that replaced a runtime check. `materialise()` used to guard
		 * `blobs[e.__layer]` with a throw, and that throw was unreachable: `blobs` and the merged
		 * index are both derived from the same `layerData`, so `__layer` is always an index into
		 * the array it was assigned from. The guard is gone; this is what keeps it true.
		 *
		 * A `__layer` already present on an input entry is the one way it could go wrong, so that
		 * is the case driven here -- the packer writes the index as JSON and nothing stops a
		 * hand-edited `core.pf.json` carrying one.
		 */
		const layers = [
			{ index: [{ p: 'a.php', o: 0, c: 1, l: 1, __layer: 99 }] },
			{ index: [{ p: 'b.php', o: 0, c: 1, l: 1, __layer: -3 }] }
		];
		const merged = _mergeLayerIndexes(layers);
		for (const entry of merged) {
			expect(entry.__layer).toBeGreaterThanOrEqual(0);
			expect(entry.__layer).toBeLessThan(layers.length);
		}
		// the incoming values really were out of range, or the loop above proves nothing
		expect(layers[0]?.index[0]?.__layer).toBe(99);
		expect(merged.map((e) => e.__layer)).toEqual([0, 1]);
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
		// a layer whose index is absent entirely: `core.pf.json` is fetched and JSON-parsed, so a
		// truncated or hand-edited asset reaches here as undefined rather than as an array
		expect(_mergeLayerIndexes([{ index: undefined as never }])).toEqual([]);
	});

	it('counts subrequests per ASSETS layer and none for R2', () => {
		// R2 costing no subrequest is the meter that made it the right store for a mutable pack
		const src = lazyFsSource.slice(lazyFsSource.indexOf('subrequests:'));
		expect(/layers\.filter\(\(l\) => !l\.r2\)\.length \* 2/.test(src)).toBe(true);
	});
});

// #region the mount, driven for real

/**
 * A fake MEMFS, and the fake is the instrument.
 *
 * `mountDrupalLazy()` does not write bytes: it calls `FS.create()` once per index entry and then
 * REPLACES that node's `stream_ops`, so what it produces is a graph of nodes whose contents are
 * still null. Every behaviour worth asserting -- that `stat()` answers the real size before
 * anything inflates, that a read materialises exactly once, that eviction is reversible -- is a
 * property of those nodes, so a fake that models `create`/`lookupPath`/`unlink` and hands out
 * MEMFS-shaped stream ops reaches all of it.
 *
 * The parent-directory check is deliberate and copied from `mount.spec.ts`: the real MEMFS raises
 * ENOENT for a create under a directory nobody made, so a mount that stopped calling `mkdirp`
 * fails here rather than silently working.
 */
interface FakeFs extends LazyFS {
	nodes: Map<string, MemfsNode>;
	dirs: string[];
}

class FakeErrnoError extends Error {
	constructor(readonly errno: number) {
		super(`errno ${errno}`);
		this.name = 'ErrnoError';
	}
}

/** MEMFS's own stream ops, narrowed to what a lazy node borrows */
const baseStreamOps: MemfsStreamOps = {
	read(stream, buffer, offset, length, position) {
		const contents = stream.node.contents ?? new Uint8Array(0);
		const count = Math.max(0, Math.min(length, contents.length - position));
		buffer.set(contents.subarray(position, position + count), offset);
		return count;
	},
	write(stream, buffer, offset, length, position) {
		const contents = stream.node.contents ?? new Uint8Array(0);
		const end = Math.max(contents.length, position + length);
		const next = new Uint8Array(end);
		next.set(contents);
		next.set(buffer.subarray(offset, offset + length), position);
		stream.node.contents = next;
		stream.node.usedBytes = end;
		return length;
	},
	mmap(stream, length, position) {
		return { ptr: position, allocated: false, size: length };
	},
	msync(_stream, _buffer, _offset, length) {
		return length;
	}
};

function fakeFs(): FakeFs {
	const nodes = new Map<string, MemfsNode>();
	const dirs: string[] = [];
	const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
	const make = (): MemfsNode => ({
		contents: null,
		usedBytes: 0,
		node_ops: { setattr: () => {} },
		stream_ops: baseStreamOps
	});
	const fs: FakeFs = {
		nodes,
		dirs,
		ErrnoError: FakeErrnoError,
		mkdir(path: string): void {
			if (dirs.includes(path)) throw new Error(`EEXIST: ${path}`);
			dirs.push(path);
		},
		writeFile(path: string, data: Uint8Array | string): void {
			const parent = parentOf(path);
			if (parent !== '' && !dirs.includes(parent)) {
				throw new Error(`ENOENT: no directory ${parent}`);
			}
			const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
			const node = make();
			node.contents = bytes;
			node.usedBytes = bytes.length;
			nodes.set(path, node);
		},
		create(path: string): MemfsNode {
			if (nodes.has(path)) throw new Error(`EEXIST: ${path}`);
			const parent = parentOf(path);
			if (parent !== '' && !dirs.includes(parent)) {
				throw new Error(`ENOENT: no directory ${parent}`);
			}
			const node = make();
			nodes.set(path, node);
			return node;
		},
		lookupPath(path: string): { node: LazyNode } {
			const node = nodes.get(path);
			if (node === undefined) throw new FakeErrnoError(44);
			return { node: node as LazyNode };
		},
		unlink(path: string): void {
			nodes.delete(path);
		}
	};
	return fs;
}

/** one file as a caller of the packer writes it */
interface PackInput {
	data: string;
	/** pack it verbatim rather than deflated, which is the `s: 1` branch */
	stored?: boolean;
	mtime?: number;
}

/** builds a per-file pack: every member compressed independently, offsets into the blob */
function packLayer(files: Record<string, string | PackInput>) {
	const members: Uint8Array[] = [];
	const index: PerFilePackEntry[] = [];
	let offset = 0;
	for (const [p, raw] of Object.entries(files)) {
		const spec: PackInput = typeof raw === 'string' ? { data: raw } : raw;
		const bytes = new TextEncoder().encode(spec.data);
		const member = spec.stored === true ? bytes : deflateSync(bytes);
		members.push(member);
		const entry: PerFilePackEntry = { p, o: offset, c: member.length, l: bytes.length };
		if (spec.stored === true) entry.s = 1;
		if (spec.mtime !== undefined) entry.m = spec.mtime;
		index.push(entry);
		offset += member.length;
	}
	const blob = new Uint8Array(offset);
	let at = 0;
	for (const member of members) {
		blob.set(member, at);
		at += member.length;
	}
	return { index, blob };
}

/** a Fetcher over a path-to-body map, counting what was asked for */
function assets(bodies: Record<string, BodyInit | undefined>) {
	const asked: string[] = [];
	const fetcher = {
		fetch: async (input: RequestInfo | URL): Promise<Response> => {
			const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
			asked.push(path);
			const body = bodies[path];
			if (body === undefined) return new Response('missing', { status: 404 });
			return new Response(body, { status: 200 });
		}
	} as unknown as Fetcher;
	return { asked, ASSETS: fetcher };
}

/** an R2 bucket over a key-to-object map */
function r2(objects: Record<string, PerFilePackEntry[] | Uint8Array>): R2Bucket {
	return {
		get: async (key: string) => {
			const value = objects[key];
			if (value === undefined) return null;
			return {
				json: async () => value,
				arrayBuffer: async () =>
					value instanceof Uint8Array
						? value.slice().buffer
						: new TextEncoder().encode(JSON.stringify(value)).buffer
			};
		}
	} as unknown as R2Bucket;
}

/** an ASSETS env holding one layer under `prefix`, plus anything extra */
function oneLayer(
	files: Record<string, string | PackInput>,
	prefix = 'drupal-pf',
	extra: Record<string, BodyInit | undefined> = {}
) {
	const { index, blob } = packLayer(files);
	return assets({
		[`/${prefix}/core.pf.json`]: JSON.stringify(index),
		[`/${prefix}/core.pf.bin`]: blob,
		...extra
	});
}

/** the node at a path, typed as the lazy mount left it */
function nodeAt(fs: FakeFs, path: string): LazyNode {
	return fs.lookupPath(path).node;
}

/** reads a whole node through its patched ops, which is what materialises it */
function readAll(node: LazyNode): string {
	const buffer = new Uint8Array(node.usedBytes);
	const stream: LazyStream = { node, position: 0 };
	const count = node.stream_ops.read(stream, buffer, 0, buffer.length, 0);
	return toUtf8(buffer.subarray(0, count));
}

async function mount(
	env: { ASSETS: Fetcher; MODULE_PACK?: R2Bucket; LAZY_FS_BUDGET_BYTES?: string | number },
	opts: LazyMountOptions = {}
) {
	const fs = fakeFs();
	const result = await mountDrupalLazy({ FS: fs } as LazyBinary, env, opts);
	return { fs, result };
}

describe('mountDrupalLazy: what it materialises, and what it does not', () => {
	beforeEach(() => resetMask());
	afterEach(() => resetMask());

	it('creates a node per entry and inflates NONE of them', async () => {
		const env = oneLayer({ 'index.php': 'alpha', 'core/x.php': 'bravo!' });
		const { fs, result } = await mount(env);

		expect(result.mode).toBe('lazy');
		expect(result.files).toBe(2);
		expect(result.inflateStats.inflated).toBe(0);
		expect(nodeAt(fs, '/drupal/index.php').contents).toBeNull();
		expect(nodeAt(fs, '/drupal/core/x.php').contents).toBeNull();
	});

	it('answers stat() with the REAL size before anything opens the file', async () => {
		// PHP's include path and Drupal's file scans both stat without reading, so a node
		// reporting 0 here makes every one of them decide the file is empty
		const { fs } = await mount(oneLayer({ 'index.php': 'alpha' }));
		expect(nodeAt(fs, '/drupal/index.php').usedBytes).toBe(5);
	});

	it('inflates on the first read and reuses the contents on the second', async () => {
		const { fs, result } = await mount(oneLayer({ 'index.php': 'alpha' }));
		const node = nodeAt(fs, '/drupal/index.php');

		expect(readAll(node)).toBe('alpha');
		expect(result.inflateStats.inflated).toBe(1);
		expect(node.cfwLoaded).toBe(true);

		expect(readAll(node)).toBe('alpha');
		expect(result.inflateStats.inflated).toBe(1);
	});

	it('copies a stored member instead of inflating it', async () => {
		// `s: 1` is the packer's "this did not compress", and running it through inflateSync
		// would throw on bytes that are not a deflate stream
		const { fs } = await mount(oneLayer({ 'raw.bin': { data: 'verbatim', stored: true } }));
		expect(readAll(nodeAt(fs, '/drupal/raw.bin'))).toBe('verbatim');
	});

	it('carries the packer mtime onto the node', async () => {
		// Drupal hashes filemtime() into compiled Twig directory names, so a write-time mtime
		// makes it miss its own cache
		const { fs } = await mount(oneLayer({ 'a.php': { data: 'x', mtime: 1700000000 } }));
		expect(nodeAt(fs, '/drupal/a.php').timestamp).toBe(1700000000);
	});

	it('counts each directory once and creates the twig cache directory', async () => {
		const { fs, result } = await mount(
			oneLayer({ 'core/a.php': 'a', 'core/b.php': 'b', 'modules/c.php': 'c' })
		);
		expect(result.dirs).toBe(2);
		expect(fs.dirs).toContain('/drupal/sites/default/files/php/twig');
	});

	it('skips an entry whose path something else already claimed', async () => {
		// the driver mount runs first in production, and its files are in the pack too
		const env = oneLayer({ 'core/a.php': 'from the pack' });
		const fs = fakeFs();
		fs.mkdir('/drupal');
		fs.mkdir('/drupal/core');
		fs.writeFile('/drupal/core/a.php', 'from the driver');
		const result = await mountDrupalLazy({ FS: fs } as LazyBinary, env);
		expect(result.files).toBe(0);
		expect(toUtf8(nodeAt(fs, '/drupal/core/a.php').contents!)).toBe('from the driver');
	});
});

describe('mountDrupalLazy: the patched stream ops', () => {
	beforeEach(() => resetMask());

	it('materialises inside the mask, and leaves the mask balanced', async () => {
		// this runs as a JS frame under the PHP stack, so a slice interrupt firing inside the
		// inflate would try to suspend a stack it cannot capture
		const { fs } = await mount(oneLayer({ 'a.php': 'alpha' }));
		const before = maskStats().enters;
		readAll(nodeAt(fs, '/drupal/a.php'));
		expect(maskStats().enters).toBe(before + 1);
		expect(maskDepth()).toBe(0);
	});

	it('materialises on llseek, and resolves all three whences', async () => {
		const { fs } = await mount(oneLayer({ 'a.php': 'abcdefghij' }));
		const node = nodeAt(fs, '/drupal/a.php');
		const stream: LazyStream = { node, position: 3 };
		const ops = node.stream_ops as unknown as {
			llseek(stream: LazyStream, offset: number, whence: number): number;
		};

		expect(ops.llseek(stream, 2, 0)).toBe(2);
		expect(node.cfwLoaded).toBe(true);
		expect(ops.llseek(stream, 2, 1)).toBe(5);
		expect(ops.llseek(stream, -1, 2)).toBe(9);
	});

	it('raises an FS errno rather than returning a negative offset', async () => {
		const { fs } = await mount(oneLayer({ 'a.php': 'abc' }));
		const node = nodeAt(fs, '/drupal/a.php');
		const ops = node.stream_ops as unknown as {
			llseek(stream: LazyStream, offset: number, whence: number): number;
		};
		expect(() => ops.llseek({ node, position: 0 }, -5, 0)).toThrow(FakeErrnoError);
	});

	it('materialises before a write, so a partial write cannot lose the packed bytes', async () => {
		// a write to a never-read file would otherwise land on empty contents
		const { fs } = await mount(oneLayer({ 'a.php': 'abcdefghij' }));
		const node = nodeAt(fs, '/drupal/a.php');
		const stream: LazyStream = { node, position: 0 };
		node.stream_ops.write(stream, new TextEncoder().encode('ZZ'), 0, 2, 0);
		expect(toUtf8(node.contents!)).toBe('ZZcdefghij');
		expect(node.cfwDirty).toBe(true);
	});

	it('delegates mmap and msync to the ops MEMFS itself made', async () => {
		const { fs } = await mount(oneLayer({ 'a.php': 'abc' }));
		const node = nodeAt(fs, '/drupal/a.php');
		const stream: LazyStream = { node, position: 0 };
		expect(node.stream_ops.mmap(stream, 3, 0, 0, 0)).toEqual({
			ptr: 0,
			allocated: false,
			size: 3
		});
		// mmap is a read, so it materialises; msync is not, so it must not
		expect(node.cfwLoaded).toBe(true);
		expect(node.stream_ops.msync(stream, new Uint8Array(3), 0, 3, 0)).toBe(3);
	});
});

describe('mountDrupalLazy: the eviction budget', () => {
	beforeEach(() => resetMask());

	/** three five-byte files, so the arithmetic against a 10-byte budget is exact */
	const three = { 'a.php': 'aaaaa', 'b.php': 'bbbbb', 'c.php': 'ccccc' };

	it('takes the budget from env and reports it', async () => {
		const env = oneLayer(three);
		const { result } = await mount({ ...env, LAZY_FS_BUDGET_BYTES: '10' });
		expect(result.budgetBytes).toBe(10);
	});

	it('defaults to 20 MB when env says nothing', async () => {
		const { result } = await mount(oneLayer(three));
		expect(result.budgetBytes).toBe(20 * 1024 * 1024);
	});

	it('drops the least-recently-inflated file once the budget is passed', async () => {
		// without this the lazy mount is a memory regression: nothing was ever released, so a
		// long-lived object converged on the union of every route it had served
		const env = oneLayer(three);
		const { fs, result } = await mount({ ...env, LAZY_FS_BUDGET_BYTES: 10 });
		readAll(nodeAt(fs, '/drupal/a.php'));
		readAll(nodeAt(fs, '/drupal/b.php'));
		readAll(nodeAt(fs, '/drupal/c.php'));

		const a = nodeAt(fs, '/drupal/a.php');
		expect(a.contents).toBeNull();
		expect(a.cfwEvicted).toBe(true);
		expect(nodeAt(fs, '/drupal/b.php').contents).not.toBeNull();
		expect(result.inflateStats.evicted).toBe(1);
		expect(result.inflateStats.evictedBytes).toBe(5);
		expect(result.inflateStats.residentBytes).toBe(10);
	});

	it('keeps answering stat() with the real size after an eviction', async () => {
		// the node is still a file of five bytes; only its contents went
		const env = oneLayer(three);
		const { fs } = await mount({ ...env, LAZY_FS_BUDGET_BYTES: 10 });
		for (const p of ['a.php', 'b.php', 'c.php']) readAll(nodeAt(fs, `/drupal/${p}`));
		expect(nodeAt(fs, '/drupal/a.php').usedBytes).toBe(5);
	});

	it('re-inflates an evicted file to the same bytes and counts the re-inflation', async () => {
		// eviction is only safe because the blob stays resident, which makes dropping contents
		// reversible rather than a bet about what is needed again
		const env = oneLayer(three);
		const { fs, result } = await mount({ ...env, LAZY_FS_BUDGET_BYTES: 10 });
		for (const p of ['a.php', 'b.php', 'c.php']) readAll(nodeAt(fs, `/drupal/${p}`));
		expect(readAll(nodeAt(fs, '/drupal/a.php'))).toBe('aaaaa');
		expect(result.inflateStats.reinflated).toBe(1);
		expect(nodeAt(fs, '/drupal/a.php').cfwEvicted).toBe(false);
	});

	it('never evicts a file PHP has written to', async () => {
		// the blob can no longer reproduce a dirty node, so dropping it would lose the write
		const env = oneLayer(three);
		const { fs } = await mount({ ...env, LAZY_FS_BUDGET_BYTES: 10 });
		const a = nodeAt(fs, '/drupal/a.php');
		a.stream_ops.write({ node: a, position: 0 }, new TextEncoder().encode('Z'), 0, 1, 0);
		readAll(nodeAt(fs, '/drupal/b.php'));
		readAll(nodeAt(fs, '/drupal/c.php'));

		expect(a.contents).not.toBeNull();
		expect(toUtf8(a.contents!)).toBe('Zaaaa');
		expect(nodeAt(fs, '/drupal/b.php').contents).toBeNull();
	});

	it('never evicts the file it was called for, even with nothing else to drop', async () => {
		// the `keep` guard: the node being materialised is the most-recently-inserted, so it is
		// the LAST candidate, and it is only reached when everything before it was unevictable.
		// Dropping it here would free the bytes the caller is about to read
		const env = oneLayer({ 'a.php': 'aaaaa', 'b.php': 'bbbbb' });
		const { fs, result } = await mount({ ...env, LAZY_FS_BUDGET_BYTES: 5 });
		const a = nodeAt(fs, '/drupal/a.php');
		a.stream_ops.write({ node: a, position: 0 }, new TextEncoder().encode('Z'), 0, 1, 0);
		const b = nodeAt(fs, '/drupal/b.php');

		expect(readAll(b)).toBe('bbbbb');
		expect(b.contents).not.toBeNull();
		// a is dirty and b is the keep, so nothing could be dropped and the budget is overrun
		expect(result.inflateStats.evicted).toBe(0);
		expect(result.inflateStats.residentBytes).toBe(10);
	});

	it('is idempotent, so a second op on a loaded node does not re-inflate it', async () => {
		// the four stream ops each used to repeat this check inline; materialise owns it now, and
		// a lost guard would double-count residentBytes and spin the LRU
		const { fs, result } = await mount(oneLayer({ 'a.php': 'aaaaa' }));
		const node = nodeAt(fs, '/drupal/a.php');
		readAll(node);
		const after = { ...result.inflateStats };
		readAll(node);
		node.stream_ops.mmap({ node, position: 0 }, 5, 0, 0, 0);
		(
			node.stream_ops as unknown as {
				llseek(s: LazyStream, o: number, w: number): number;
			}
		).llseek({ node, position: 0 }, 0, 0);
		expect(result.inflateStats.inflated).toBe(after.inflated);
		expect(result.inflateStats.residentBytes).toBe(after.residentBytes);
	});

	it('records the high-water mark, which is the number the cap exists for', async () => {
		const env = oneLayer(three);
		const { fs, result } = await mount({ ...env, LAZY_FS_BUDGET_BYTES: 10 });
		for (const p of ['a.php', 'b.php', 'c.php']) readAll(nodeAt(fs, `/drupal/${p}`));
		expect(result.inflateStats.highWaterBytes).toBe(15);
		expect(result.inflateStats.inflatedBytes).toBe(15);
	});
});

describe('mountDrupalLazy: layers', () => {
	beforeEach(() => resetMask());

	it('inflates each entry from ITS OWN layer blob', async () => {
		// the sharp case: both members sit at offset 0 of their own blob, so a mount that always
		// reached for blobs[0] would hand back the wrong file's bytes and throw nothing
		const core = packLayer({ 'a.php': 'AAAA' });
		const mods = packLayer({ 'b.php': 'BBBB' });
		const env = assets({
			'/core-pf/core.pf.json': JSON.stringify(core.index),
			'/core-pf/core.pf.bin': core.blob,
			'/mods-pf/core.pf.json': JSON.stringify(mods.index),
			'/mods-pf/core.pf.bin': mods.blob
		});
		const { fs, result } = await mount(env, {
			layers: [{ prefix: 'core-pf' }, { prefix: 'mods-pf' }]
		});

		expect(mods.index[0]?.o).toBe(0);
		expect(readAll(nodeAt(fs, '/drupal/a.php'))).toBe('AAAA');
		expect(readAll(nodeAt(fs, '/drupal/b.php'))).toBe('BBBB');
		expect(result.layers.map((l) => l.name)).toEqual(['core-pf', 'mods-pf']);
		expect(result.blobBytes).toBe(core.blob.length + mods.blob.length);
		expect(result.subrequests).toBe(4);
	});

	it('lets a later layer replace a file the earlier one shipped', async () => {
		const core = packLayer({ 'a.php': 'from core' });
		const mods = packLayer({ 'a.php': 'from the module layer' });
		const env = assets({
			'/core-pf/core.pf.json': JSON.stringify(core.index),
			'/core-pf/core.pf.bin': core.blob,
			'/mods-pf/core.pf.json': JSON.stringify(mods.index),
			'/mods-pf/core.pf.bin': mods.blob
		});
		const { fs, result } = await mount(env, {
			layers: [{ prefix: 'core-pf' }, { prefix: 'mods-pf' }]
		});
		expect(result.files).toBe(1);
		expect(readAll(nodeAt(fs, '/drupal/a.php'))).toBe('from the module layer');
	});

	it('reads an R2 layer through MODULE_PACK and spends no subrequest on it', async () => {
		// R2 costing no subrequest is the meter that made it the right store for a mutable pack
		const core = packLayer({ 'a.php': 'core' });
		const mods = packLayer({ 'b.php': 'module' });
		const env = oneLayer({ 'a.php': 'core' }, 'core-pf');
		const withR2 = {
			...env,
			MODULE_PACK: r2({ 'modules.pf.json': mods.index, 'modules.pf.bin': mods.blob })
		};
		const { fs, result } = await mount(withR2, {
			layers: [{ prefix: 'core-pf' }, { r2: 'modules' }]
		});

		expect(core.index).toHaveLength(1);
		expect(readAll(nodeAt(fs, '/drupal/b.php'))).toBe('module');
		expect(result.subrequests).toBe(2);
		expect(result.layers[1]?.name).toBe('modules');
	});

	it('names the layer when it wants R2 and no bucket is bound', async () => {
		const env = oneLayer({ 'a.php': 'core' }, 'core-pf');
		await expect(mount(env, { layers: [{ r2: 'modules', name: 'mutable' }] })).rejects.toThrow(
			'layer mutable wants R2 but MODULE_PACK is not bound'
		);
	});

	it('names both R2 keys when the objects are missing', async () => {
		const env = oneLayer({ 'a.php': 'core' }, 'core-pf');
		await expect(
			mount({ ...env, MODULE_PACK: r2({}) }, { layers: [{ r2: 'modules' }] })
		).rejects.toThrow(/modules\.pf\.json \/ \.pf\.bin/);
	});

	it('names both statuses when an ASSETS pack is not reachable', async () => {
		await expect(mount(assets({}))).rejects.toThrow(/core\.pf\.json 404, core\.pf\.bin 404/);
	});
});

describe('mountDrupalLazy: the database it does not fetch', () => {
	beforeEach(() => resetMask());

	it('skips site.sqlite by default and spends two subrequests', async () => {
		const env = oneLayer({ 'a.php': 'x' }, 'drupal-pf', {
			'/drupal/site.sqlite': new Uint8Array([1, 2, 3, 4])
		});
		const { result } = await mount(env);
		expect(result.dbBytes).toBe(0);
		expect(result.subrequests).toBe(2);
		expect(env.asked).not.toContain('/drupal/site.sqlite');
	});

	it('fetches and writes it when asked, and bills the extra subrequest', async () => {
		const env = oneLayer({ 'a.php': 'x' }, 'drupal-pf', {
			'/drupal/site.sqlite': new Uint8Array([1, 2, 3, 4])
		});
		const { fs, result } = await mount(env, { database: true });
		expect(result.dbBytes).toBe(4);
		expect(result.subrequests).toBe(3);
		expect(fs.nodes.get('/drupal/sites/default/files/.sqlite')?.usedBytes).toBe(4);
	});

	it('reads it from a different prefix when told to', async () => {
		const env = oneLayer({ 'a.php': 'x' }, 'drupal-pf', {
			'/drupal-std/site.sqlite': new Uint8Array(9)
		});
		const { result } = await mount(env, { database: true, dbPrefix: 'drupal-std' });
		expect(result.dbPrefix).toBe('drupal-std');
		expect(result.dbBytes).toBe(9);
	});

	it('writes no database when the asset is missing, rather than an empty one', async () => {
		const env = oneLayer({ 'a.php': 'x' });
		const { fs, result } = await mount(env, { database: true });
		expect(result.dbBytes).toBe(0);
		expect(fs.nodes.has('/drupal/sites/default/files/.sqlite')).toBe(false);
	});
});

// #endregion
