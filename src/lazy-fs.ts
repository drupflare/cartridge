/**
 * Mounts the Drupal tree WITHOUT materialising it, by inflating each file the first
 * time PHP opens it.
 *
 * The old blocker was random access: ONE gzip stream cannot be seeked, so reaching
 * the last file means inflating everything before it. `scripts/pack-perfile.ts`
 * compresses every file independently, which trades 8.12 MB -> 11.4 MB of asset
 * (still 13.6 MB inside the 25 MiB per-asset ceiling) for the ability to inflate
 * exactly the files that get read. Measured: boot plus one anonymous front-page render
 * reads **1,006 of the 11,421**.
 *
 * `inflateSync` from fflate rather than DecompressionStream because this has to happen
 * inside a synchronous `open()` from wasm -- an async inflate cannot be awaited there,
 * which is the whole reason lazy loading was ruled out before.
 */

import { inflateSync } from 'fflate';
import { maskEnter, maskExit } from './mask';
import { mkdirp, type MountFS } from './mount';

/**
 * One file in a per-file pack index (`core.pf.json`).
 *
 * NOT interchangeable with `StreamPackEntry` from `mount.js`, whose `o` indexes the inflated
 * stream and which carries no `c` at all; see the note there.
 */
export interface PerFilePackEntry {
	/** relative path inside the tree */
	p: string;
	/** byte offset of this member in its layer's blob, which is compressed */
	o: number;
	/** compressed length */
	c: number;
	/** inflated length */
	l: number;
	/** mtime, when the packer recorded one */
	m?: number;
	/** 1 when stored verbatim rather than deflated */
	s?: number;
	/** which layer it came from; set by _mergeLayerIndexes */
	__layer?: number;
}

/** One layer as a caller writes it: an ASSETS prefix or an R2 key, either of them nameable. */
export interface LayerSpec {
	prefix?: string;
	r2?: string;
	name?: string;
}

/** One layer after normalisation, which is where the name stops being optional. */
export interface PackLayer extends LayerSpec {
	name: string;
}

/** The mount options; `layers` wins over `prefix` when both are given. */
export interface LazyMountOptions {
	prefix?: string;
	dbPrefix?: string;
	database?: boolean;
	layers?: LayerSpec[];
}

/** The bindings a lazy mount reads its layers through, plus the one knob it takes from env. */
export interface LazyFsEnv {
	ASSETS: Fetcher;
	MODULE_PACK?: R2Bucket;
	LAZY_FS_BUDGET_BYTES?: string | number;
}

/**
 * The MEMFS stream ops a lazy node borrows.
 *
 * Taken from a node the runtime itself made rather than declared against a specific
 * emscripten, so this names only the five entry points the patch delegates to.
 */
export interface MemfsStreamOps {
	read(
		stream: LazyStream,
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number
	): number;
	write(
		stream: LazyStream,
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
		canOwn?: boolean
	): number;
	mmap(
		stream: LazyStream,
		length: number,
		position: number,
		prot: number,
		flags: number
	): unknown;
	msync(
		stream: LazyStream,
		buffer: Uint8Array,
		offset: number,
		length: number,
		mmapFlags: number
	): number;
}

/** A MEMFS node as `FS.create()` hands it back, before the lazy mount patches it. */
export interface MemfsNode {
	contents: Uint8Array | null;
	usedBytes: number;
	timestamp?: number;
	node_ops: unknown;
	stream_ops: MemfsStreamOps;
}

/**
 * A node the lazy mount owns: it carries the index entry its contents inflate from.
 *
 * `cfwDirty` and `cfwEvicted` are absent until something happens to the node, which is what
 * distinguishes "never written" from "written, so the blob can no longer reproduce it".
 */
export interface LazyNode extends MemfsNode {
	cfwEntry: PerFilePackEntry;
	cfwLoaded: boolean;
	cfwDirty?: boolean;
	cfwEvicted?: boolean;
}

/** An open file, narrowed to what the patched ops touch. */
export interface LazyStream {
	node: LazyNode;
	position: number;
}

/** The MEMFS surface a lazy mount drives; wider than a streaming mount's because it patches nodes. */
export interface LazyFS extends MountFS {
	ErrnoError: new (errno: number) => Error;
	lookupPath(path: string): { node: LazyNode };
	unlink(path: string): void;
	create(path: string, mode: number): MemfsNode;
}

/** A php-wasm module, narrowed to the one member a lazy mount touches. */
export interface LazyBinary {
	FS: LazyFS;
}

/** How much of the tree the mount actually materialised, and what eviction cost. */
export interface InflateStats {
	files: number;
	dirs: number;
	inflated: number;
	inflatedBytes: number;
	residentBytes: number;
	highWaterBytes: number;
	evicted: number;
	evictedBytes: number;
	reinflated: number;
}

/** What a lazy mount reports. The streaming mount's counterpart is `MountResult`. */
export interface LazyMountResult {
	mode: string;
	prefix: string;
	dbPrefix: string;
	files: number;
	dirs: number;
	blobBytes: number;
	layers: Array<{ name: string; bytes: number }>;
	dbBytes: number;
	fetchMs: number;
	nodeMs: number;
	subrequests: number;
	budgetBytes: number;
	inflateStats: InflateStats;
}

/**
 * Normalises the layer list.
 *
 * ONE LAYER IS THE OLD BEHAVIOUR EXACTLY, which is the point: `{prefix: 'drupal-pf'}` produces
 * the same single fetch pair, the same merged index and the same `blobs[0]` the single-blob
 * version used, so enabling layers cannot regress the mount that already works.
 *
 * More than one layer is what makes runtime module installation possible without a Worker
 * version. `core.pf.bin` is immutable and comes from ASSETS; `modules.pf.bin` is mutable and
 * comes from R2, so an install writes an R2 object and bumps a generation instead of calling
 * `versions.create`. That also deletes the self-redeployment privilege-escalation surface the
 * security section flags, because no API token with Workers Scripts edit needs to exist.
 *
 * @internal Exported for the gate lane; a full mount needs a real emscripten FS.
 *
 * @param opts
 *   Mount options; `layers` wins over `prefix` when both are given.
 * @returns
 *   Layers in priority order, lowest priority first.
 */
export function _normaliseLayers(opts: LazyMountOptions): PackLayer[] {
	if (Array.isArray(opts.layers) && opts.layers.length > 0) {
		return opts.layers.map((l, i) => ({
			...l,
			name: l.name ?? l.prefix ?? l.r2 ?? `layer${i}`
		}));
	}
	const prefix = opts.prefix ?? 'drupal-pf';
	return [{ prefix, name: prefix }];
}

/**
 * Fetches one layer's index and blob.
 *
 * @param layer
 *   `{prefix}` reads from ASSETS; `{r2}` reads that key from the MODULE_PACK bucket.
 * @param env
 *   Worker env carrying ASSETS and optionally MODULE_PACK.
 * @returns
 *   The parsed index and the resident blob.
 */
async function fetchLayer(
	layer: PackLayer,
	env: LazyFsEnv
): Promise<{ index: PerFilePackEntry[]; blob: Uint8Array }> {
	if (layer.r2) {
		const bucket = env.MODULE_PACK;
		if (!bucket) throw new Error(`layer ${layer.name} wants R2 but MODULE_PACK is not bound`);
		const [idxObj, binObj] = await Promise.all([
			bucket.get(`${layer.r2}.pf.json`),
			bucket.get(`${layer.r2}.pf.bin`)
		]);
		if (!idxObj || !binObj) {
			throw new Error(`layer ${layer.name} not in R2: ${layer.r2}.pf.json / .pf.bin`);
		}
		return {
			index: await idxObj.json<PerFilePackEntry[]>(),
			blob: new Uint8Array(await binObj.arrayBuffer())
		};
	}
	const [idxRes, binRes] = await Promise.all([
		env.ASSETS.fetch(new URL(`https://a.local/${layer.prefix}/core.pf.json`)),
		env.ASSETS.fetch(new URL(`https://a.local/${layer.prefix}/core.pf.bin`))
	]);
	if (!idxRes.ok || !binRes.ok) {
		throw new Error(
			`per-file pack not reachable: core.pf.json ${idxRes.status}, core.pf.bin ${binRes.status}`
		);
	}
	return {
		index: await idxRes.json<PerFilePackEntry[]>(),
		blob: new Uint8Array(await binRes.arrayBuffer())
	};
}

/**
 * Merges layer indexes, later layers overriding earlier ones on the same path.
 *
 * @internal Exported for the gate lane.
 *
 * @param layerData
 *   Fetched layers, lowest priority first.
 * @returns
 *   Entries tagged with `__layer`.
 */
export function _mergeLayerIndexes(
	layerData: Array<{ index: PerFilePackEntry[] }>
): PerFilePackEntry[] {
	const merged = new Map<string, PerFilePackEntry>();
	for (let li = 0; li < layerData.length; li++) {
		const layerIndex = layerData[li]?.index ?? [];
		for (const e of layerIndex) {
			if (!e.p || e.p.startsWith('/')) continue;
			merged.set(e.p, { ...e, __layer: li });
		}
	}

	return [...merged.values()].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}

export async function mountDrupalLazy(
	binary: LazyBinary,
	env: LazyFsEnv,
	opts: LazyMountOptions = {}
): Promise<LazyMountResult> {
	const FS = binary.FS;
	const layers = _normaliseLayers(opts);
	const prefix = layers[0]?.prefix ?? opts.prefix ?? 'drupal-pf';
	const dbPrefix = opts.dbPrefix ?? 'drupal';
	const t0 = Date.now();

	const wantDatabase = opts.database === true;
	const [layerData, dbRes] = await Promise.all([
		Promise.all(layers.map((l) => fetchLayer(l, env))),
		wantDatabase
			? env.ASSETS.fetch(new URL(`https://a.local/${dbPrefix}/site.sqlite`))
			: // `false as const` so the `dbRes.ok` check below still narrows this apart from a Response
				Promise.resolve({ ok: false as const, skipped: true })
	]);

	// resident for the life of the isolate; each is one whole layer, compressed
	const blobs = layerData.map((d) => d.blob);
	const index = _mergeLayerIndexes(layerData);
	const tFetch = Date.now();

	/**
	 * Byte budget for materialised contents, above which the least-recently-inflated
	 * file is dropped.
	 *
	 * WITHOUT THIS THE LAZY MOUNT IS A MEMORY REGRESSION, not just a time win. 1,006
	 * files is boot plus ONE anonymous front-page render; admin, authenticated and Views
	 * paths reach much further, and nothing was ever released, so a long-lived object
	 * converges on the union of every route it has served: 11.4 MB blob + 1.26 MB index
	 * + up to 39 MB inflated = ~52 MB, against the streaming mount's 39 MB. Warm-window
	 * batching makes that convergence the normal case rather than the tail.
	 *
	 * Eviction is only safe because the blob stays resident: dropping contents is
	 * reversible, so this is a plain LRU rather than a bet about which files are needed
	 * again. Re-inflating is idempotent and produces identical bytes, so eviction needs
	 * no bookkeeping beyond the counters.
	 */
	const budgetBytes = Number(env?.LAZY_FS_BUDGET_BYTES ?? 20 * 1024 * 1024);

	/** insertion-ordered; a Map's iteration order IS the LRU order here */
	const resident = new Map<LazyNode, number>();

	const stats: InflateStats = {
		files: 0,
		dirs: 0,
		inflated: 0,
		inflatedBytes: 0,
		residentBytes: 0,
		highWaterBytes: 0,
		evicted: 0,
		evictedBytes: 0,
		reinflated: 0
	};

	/** Drops contents until the resident set fits the budget, never touching `keep`. */
	function evictDownTo(keep: LazyNode): void {
		for (const node of resident.keys()) {
			if (stats.residentBytes <= budgetBytes) break;
			if (node === keep) continue;
			// a file PHP has written to is no longer reproducible from the blob
			if (node.cfwDirty) continue;
			// always present: `node` came out of `resident.keys()` two lines up
			const bytes = resident.get(node) ?? 0;
			resident.delete(node);
			node.contents = null;
			node.cfwLoaded = false;
			// marked on the NODE, because `resident` has just forgotten it and a
			// re-inflation would otherwise be invisible
			node.cfwEvicted = true;
			// usedBytes must keep answering stat() with the real size
			node.usedBytes = node.cfwEntry.l;
			stats.residentBytes -= bytes;
			stats.evicted++;
			stats.evictedBytes += bytes;
		}
	}

	/**
	 * Materialises one node's contents from the resident blob.
	 *
	 * Assigning a real Uint8Array to `node.contents` is what makes the node
	 * indistinguishable from an eagerly-written MEMFS file afterwards, so every other
	 * FS operation -- seek, mmap, a second read -- needs no special case.
	 *
	 * THE WHOLE BODY IS MASKED, not just the inflate. This runs as a JS frame under
	 * the PHP stack, so a slice interrupt firing anywhere inside it would try to
	 * suspend a stack it cannot capture (src/mask.js). The raw enter/exit pair rather
	 * than `withMask()` because this is the hot path -- 1,006 first reads during boot
	 * plus one front-page render -- and the pair costs no closure per call.
	 */
	function materialise(node: LazyNode): void {
		const e = node.cfwEntry;
		if (!e || node.cfwLoaded) return;
		maskEnter();
		try {
			// the entry names its own layer, so a modules-layer file inflates from the modules blob
			const blob = blobs[e.__layer ?? 0];
			if (!blob)
				throw new Error(`entry ${e.p} names layer ${e.__layer} which was not fetched`);
			const member = blob.subarray(e.o, e.o + e.c);
			node.contents = e.s
				? member.slice()
				: inflateSync(member, { out: new Uint8Array(e.l) });
			node.usedBytes = node.contents.length;
			node.cfwLoaded = true;
			if (node.cfwEvicted) {
				stats.reinflated++;
				node.cfwEvicted = false;
			}
			resident.delete(node); // re-insert so it becomes most-recently-used
			resident.set(node, node.usedBytes);
			stats.inflated++;
			stats.inflatedBytes += node.usedBytes;
			stats.residentBytes += node.usedBytes;
			if (stats.residentBytes > stats.highWaterBytes) {
				stats.highWaterBytes = stats.residentBytes;
			}
			if (stats.residentBytes > budgetBytes) evictDownTo(node);
		} finally {
			maskExit();
		}
	}
	const dirs = new Set<string>();

	// Patched onto each lazy node rather than onto MEMFS globally: a global patch would
	// also intercept the database file and every file Drupal writes at runtime.
	const lazyStreamOps = {
		llseek(stream: LazyStream, offset: number, whence: number) {
			if (!stream.node.cfwLoaded) materialise(stream.node);
			let position = offset;
			if (whence === 1) position += stream.position;
			else if (whence === 2) position += stream.node.usedBytes;
			if (position < 0) throw new FS.ErrnoError(28);
			return position;
		},
		read(
			stream: LazyStream,
			buffer: Uint8Array,
			offset: number,
			length: number,
			position: number
		) {
			if (!stream.node.cfwLoaded) materialise(stream.node);
			return baseStreamOps.read(stream, buffer, offset, length, position);
		},
		write(
			stream: LazyStream,
			buffer: Uint8Array,
			offset: number,
			length: number,
			position: number,
			canOwn?: boolean
		) {
			// a write to a never-read file would otherwise land on empty contents and lose
			// whatever the lazy member held
			if (!stream.node.cfwLoaded) materialise(stream.node);
			// the blob can no longer reproduce this node, so eviction must skip it forever
			stream.node.cfwDirty = true;
			return baseStreamOps.write(stream, buffer, offset, length, position, canOwn);
		},
		mmap(stream: LazyStream, length: number, position: number, prot: number, flags: number) {
			if (!stream.node.cfwLoaded) materialise(stream.node);
			return baseStreamOps.mmap(stream, length, position, prot, flags);
		},
		msync(
			stream: LazyStream,
			buffer: Uint8Array,
			offset: number,
			length: number,
			mmapFlags: number
		) {
			return baseStreamOps.msync(stream, buffer, offset, length, mmapFlags);
		}
	};

	// A real node has to exist before its stream_ops can be borrowed, and the shape of
	// MEMFS's ops is an internal detail of whichever emscripten built this binary --
	// so take them from a node the runtime itself made rather than hardcoding them.
	mkdirp(FS, '/drupal');
	FS.writeFile('/drupal/.cfw-probe', new Uint8Array(1));
	const probe = FS.lookupPath('/drupal/.cfw-probe').node;
	const baseStreamOps = probe.stream_ops;
	const baseNodeOps = probe.node_ops;
	FS.unlink('/drupal/.cfw-probe');

	for (const e of index) {
		const full = '/drupal/' + e.p;
		const cut = full.lastIndexOf('/');
		const dir = full.slice(0, cut);
		if (!dirs.has(dir)) {
			mkdirp(FS, dir);
			dirs.add(dir);
			stats.dirs++;
		}

		// 0o100000 is S_IFREG; FS.create() is mknod(), which returns the node and copies
		// nothing. This is the line that replaces a writeFile of the inflated bytes.
		// the cast is made good by the six assignments below it: the node leaves this block
		// carrying its index entry, which is what makes it a LazyNode
		let node: LazyNode;
		try {
			node = FS.create(full, 0o100000 | 0o666) as LazyNode;
		} catch {
			continue; // already present, e.g. the driver was mounted first
		}
		node.node_ops = baseNodeOps;
		node.stream_ops = lazyStreamOps;
		node.cfwEntry = e;
		node.cfwLoaded = false;
		// stat() must answer with the REAL size before anyone opens the file: PHP's
		// include path and Drupal's file scans both stat without reading
		node.usedBytes = e.l;
		node.contents = null;
		if (e.m) {
			node.timestamp = e.m;
		}
		stats.files++;
	}

	let dbBytes = 0;
	mkdirp(FS, '/drupal/sites/default/files/php/twig');
	if (dbRes.ok) {
		const db = new Uint8Array(await dbRes.arrayBuffer());
		FS.writeFile('/drupal/sites/default/files/.sqlite', db);
		dbBytes = db.length;
	}

	return {
		mode: 'lazy',
		prefix,
		dbPrefix,
		files: stats.files,
		dirs: stats.dirs,
		blobBytes: blobs.reduce((n, b) => n + b.length, 0),
		layers: layers.map((l, i) => ({ name: l.name, bytes: blobs[i]?.length ?? 0 })),
		dbBytes,
		fetchMs: tFetch - t0,
		nodeMs: Date.now() - tFetch,
		// counted, not assumed: skipping the database really does spend one fewer
		// two ASSETS fetches per asset-backed layer, plus the database when asked for. An R2
		// layer costs no subrequest at all, which is the meter that made R2 the right store
		subrequests: layers.filter((l) => !l.r2).length * 2 + (wantDatabase ? 1 : 0),
		budgetBytes,
		// read after a render to see how much of the tree boot actually touches
		inflateStats: stats
	};
}
