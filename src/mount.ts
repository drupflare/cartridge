/**
 * Mounts the packed Drupal tree into a php-wasm MEMFS.
 *
 * Extracted from src/prof.js unchanged in behaviour so the Durable Object can
 * mount the same pack without importing a 2,500-line diagnostic worker. prof.js
 * keeps its own copy; this file is the one new code uses.
 *
 * CONVERTED FROM JAVASCRIPT, the same way `src/runtime/serialize.ts` was: importers keep the
 * `./mount.js` specifier because the bundler resolves it to this file, so no call site changed.
 */

import { MountError } from './errors';
import { toBytes, toUtf8 } from './util';

/**
 * The MEMFS calls a mount makes; emscripten's FS is far wider than this.
 *
 * `utime` IS OPTIONAL, AND THAT IS A MEASURED WIDENING RATHER THAN A CONVENIENCE. wasmoon's Lua 5.4
 * build ships a real emscripten `FS` with `mkdir` and `writeFile` and **no `utime` at all**
 * (`typeof FS.utime === 'undefined'`, checked in `tests/interpreters/real-builds.spec.ts`), so a
 * required member would have excluded a build that this package otherwise drives end to end.
 * Nothing in `mountRecord()` or `mkdirp()` ever calls it; `mountDrupalStreaming()` is the one caller
 * and it only wants it because Drupal hashes `filemtime()` into compiled Twig directory names.
 */
export interface MountFS {
	mkdir(path: string): void;
	writeFile(path: string, data: Uint8Array | string): void;
	utime?(path: string, atime: number, mtime: number): void;
}

/** A php-wasm module, narrowed to the one member a mount touches. */
export interface MountBinary {
	FS: MountFS;
}

/** The binding a mount reads its pack through. */
export interface MountEnv {
	ASSETS: Fetcher;
}

/**
 * One `core.json` entry: path, offset into the inflated stream, length, mtime.
 *
 * The short keys are the packer's, not an abbreviation applied here: the index ships as an
 * asset and every byte of it is fetched before a single file is written.
 *
 * NOT interchangeable with `PerFilePackEntry`, which is why the two are named apart instead of
 * merged. `o` here indexes the INFLATED concatenation that `core.bin.gz` decompresses to -- the
 * packer advances it by each raw file length -- so there is no compressed length to carry and
 * `l` is the member's length in the stream and the file's size at once. The per-file pack
 * offsets into the COMPRESSED blob and needs `c` beside `l`, so one interface covering both
 * would give `o` two meanings and make `c` optional for the reader that cannot work without it.
 */
export interface StreamPackEntry {
	/** relative path inside the tree */
	p: string;
	/** byte offset of this member in the inflated stream */
	o: number;
	/** length, in the stream and on disk alike */
	l: number;
	/** mtime, when the packer recorded one */
	m?: number;
}

export interface MountOptions {
	prefix?: string;
	dbPrefix?: string;
	database?: boolean;
}

/** What a streaming mount reports; `peakCarryBytes` is the number the memory cap turns on. */
export interface MountResult {
	mode: string;
	prefix: string;
	dbPrefix: string;
	files: number;
	bytes: number;
	dbBytes: number;
	peakCarryBytes: number;
	fetchMs: number;
	writeMs: number;
	subrequests: number;
	databaseSkipped: boolean;
}

export interface DriverMountResult {
	files: number;
	bytes: number;
}

/**
 * A small set of files as a caller writes them: path to contents, strings or bytes.
 *
 * The string half is the point. A caller handing a script or a config file to an interpreter has a
 * string, not a `Uint8Array`, and making them build a `TextEncoder` for it is the ergonomics failure
 * this type exists to prevent.
 */
export type FileMap = Record<string, string | Uint8Array>;

/** what a record mount wrote */
export interface RecordMountResult {
	files: number;
	bytes: number;
	paths: string[];
}

/**
 * Writes a plain record of files into the FS, creating parent directories.
 *
 * FOR THE SMALL CASE, WHICH IS MOST FIRST USES. A pack is the right answer for a 11,421-file CMS
 * tree; it is the wrong answer for the three files an interpreter needs to run one script, and
 * making a pack the only mount path is what makes a library feel like it needs a build step.
 *
 * @param FS
 *   The emscripten FS to write through.
 * @param files
 *   Path to contents. A relative path is resolved under `root`.
 * @param root
 *   Prefix for relative paths; ignored for a path that already starts with `/`.
 * @returns
 *   How many files were written, how many bytes, and the absolute paths.
 * @throws MountError
 *   When the FS refuses a write, with the path named.
 */
export function mountRecord(FS: MountFS, files: FileMap, root = ''): RecordMountResult {
	const paths: string[] = [];
	let bytes = 0;
	for (const [rel, contents] of Object.entries(files)) {
		const full = rel.startsWith('/') ? rel : `${root.replace(/\/$/, '')}/${rel}`;
		const dir = full.slice(0, full.lastIndexOf('/'));
		if (dir !== '') mkdirp(FS, dir);
		const data = toBytes(contents);
		try {
			FS.writeFile(full, data);
		} catch (cause) {
			throw new MountError(
				`could not write ${full}: ${String(cause)}`,
				'mount.write_refused'
			);
		}
		paths.push(full);
		bytes += data.length;
	}
	return { files: paths.length, bytes, paths };
}

/** emscripten has no mkdir -p */
export function mkdirp(FS: MountFS, path: string): void {
	let cur = '';
	for (const seg of path.split('/').filter(Boolean)) {
		cur += '/' + seg;
		try {
			FS.mkdir(cur);
		} catch {
			// exists
		}
	}
}

/**
 * A `MountFS` backed by a `Map`, for an interpreter whose build exposes no filesystem.
 *
 * WHY THIS SHIPS RATHER THAN BEING A SNIPPET. It was hand-rolled nine times before it existed: four
 * times in `tests/recipes.spec.ts`, twice in ADVANCED_USAGE.md, and once per library-style adapter in
 * `tests/interpreters/real-builds.spec.ts`. Every copy was the same three no-op-or-store methods
 * plus a `TextDecoder` in the `writeFile` branch, which is precisely the encoder this package
 * promises no caller ever builds.
 *
 * It is NOT a MEMFS emulator and must not become one: the real emscripten MEMFS raises `ENOENT` for
 * a write under a directory nobody created, and `tests/mount.spec.ts` keeps its own strict fake for
 * exactly that reason. This one accepts any path, because an adapter that stores sources in a `Map`
 * has no directories to get wrong.
 */
export interface MemoryFS extends MountFS {
	/** every write so far, absolute path to bytes */
	files: Map<string, Uint8Array>;
	/** the bytes written at `path`, or undefined */
	read(path: string): Uint8Array | undefined;
	/** the same bytes, UTF-8 decoded, so an adapter never builds a `TextDecoder` */
	readText(path: string): string | undefined;
}

/**
 * Builds a `MemoryFS`.
 *
 * @returns
 *   A fresh one, with nothing written.
 *
 * @example
 * ```ts
 * import { createCartridge, createMemoryFS } from '@drupflare/cartridge';
 *
 * const fs = createMemoryFS();
 * const cartridge = createCartridge({
 * 	instantiate: (io) => ({
 * 		FS: fs,
 * 		callMain: (argv) => {
 * 			// evaluate fs.readText(argv[argv.length - 1]) with the embedded interpreter here
 * 			io.print('done');
 * 			return 0;
 * 		}
 * 	})
 * });
 * ```
 */
export function createMemoryFS(): MemoryFS {
	const files = new Map<string, Uint8Array>();
	return {
		files,
		// no-op rather than tracked: a Map has no directories, and pretending otherwise would invite
		// callers to assert on a hierarchy this does not have
		mkdir(): void {},
		writeFile(path: string, data: Uint8Array | string): void {
			files.set(path, toBytes(data));
		},
		utime(): void {},
		read(path: string): Uint8Array | undefined {
			return files.get(path);
		},
		readText(path: string): string | undefined {
			const bytes = files.get(path);
			return bytes === undefined ? undefined : toUtf8(bytes);
		}
	};
}

/**
 * Streaming mount: inflate the pack and write each file as its bytes arrive,
 * never holding the whole inflated tree.
 *
 * The naive version holds three copies at once -- the compressed blob, the
 * inflated buffer, and the MEMFS copies -- which peaks around 145-157 MB against
 * a 128 MB isolate cap. Here the resident set is one pending chunk plus the
 * unconsumed tail.
 *
 * Requires the index to be ordered by offset, which the packer guarantees
 * because it appends sequentially.
 */
export async function mountDrupalStreaming(
	binary: MountBinary,
	env: MountEnv,
	opts: MountOptions = {}
): Promise<MountResult> {
	const prefix = opts.prefix ?? 'drupal';
	// The database can come from a DIFFERENT pack than the code, and it has to be
	// able to: `assets/drupal/site.sqlite` has no `node.type.*` config at all, so no
	// content can be created on it, while `assets/drupal-std/site.sqlite` carries the
	// bundles. Same core tree either way, so this swaps the site rather than the site
	// AND the code.
	const dbPrefix = opts.dbPrefix ?? prefix;
	// The packed .sqlite exists for ONE consumer: MIGRATE_DB opening it through PDO. With
	// src/migrate-sql.js replaying the site in JavaScript instead, nothing in the tree reads
	// it, so fetching it is 6.47 MB and one of the 50 subrequests an invocation gets, spent
	// on a file no code opens.
	const wantDatabase = opts.database !== false;
	const t0 = Date.now();
	const [idxRes, binRes, dbRes] = await Promise.all([
		env.ASSETS.fetch(new URL(`https://a.local/${prefix}/core.json`)),
		env.ASSETS.fetch(new URL(`https://a.local/${prefix}/core.bin.gz`)),
		// `false as const` so the `dbRes.ok` check below still narrows this apart from a Response
		wantDatabase
			? env.ASSETS.fetch(new URL(`https://a.local/${dbPrefix}/site.sqlite`))
			: Promise.resolve({ ok: false as const, skipped: true })
	]);
	if (!idxRes.ok || !binRes.ok) {
		throw new Error(
			`pack not reachable from this context: core.json ${idxRes.status}, core.bin.gz ${binRes.status}`
		);
	}
	const index = await idxRes.json<StreamPackEntry[]>();
	const tFetch = Date.now();

	// an ok asset response always carries a body
	const reader = binRes.body!.pipeThrough(new DecompressionStream('gzip')).getReader();
	const dirs = new Set<string>();

	let carry = new Uint8Array(0);
	let base = 0; // absolute offset of carry[0] within the inflated stream
	let bytes = 0;
	let peakCarry = 0;
	let done = false;

	for (const e of index) {
		if (e.p.startsWith('/')) continue;
		const need = e.o + e.l;
		while (!done && base + carry.length < need) {
			const r = await reader.read();
			if (r.done) {
				done = true;
				break;
			}
			const next = new Uint8Array(carry.length + r.value.length);
			next.set(carry);
			next.set(r.value, carry.length);
			carry = next;
			if (carry.length > peakCarry) peakCarry = carry.length;
		}

		const start = e.o - base;
		if (start < 0 || start + e.l > carry.length) continue; // stream ended short

		const dir = '/drupal/' + e.p.split('/').slice(0, -1).join('/');
		if (!dirs.has(dir)) {
			mkdirp(binary.FS, dir);
			dirs.add(dir);
		}
		const full = '/drupal/' + e.p;
		binary.FS.writeFile(full, carry.subarray(start, start + e.l));
		// Drupal hashes filemtime() into compiled Twig directory names, so
		// write-time mtimes make it miss its own cache
		if (e.m) {
			try {
				binary.FS.utime?.(full, e.m, e.m);
			} catch {
				/* some paths reject utime; not fatal */
			}
		}
		bytes += e.l;

		// release everything consumed so far; this is what keeps the peak flat
		carry = carry.slice(need - base);
		base = need;
	}

	let dbBytes = 0;
	mkdirp(binary.FS, '/drupal/sites/default/files/php/twig');
	if (dbRes.ok) {
		const db = new Uint8Array(await dbRes.arrayBuffer());
		binary.FS.writeFile('/drupal/sites/default/files/.sqlite', db);
		dbBytes = db.length;
	}

	return {
		mode: 'streaming',
		prefix,
		dbPrefix,
		files: index.length,
		bytes,
		dbBytes,
		peakCarryBytes: peakCarry,
		fetchMs: tFetch - t0,
		writeMs: Date.now() - tFetch,
		subrequests: wantDatabase ? 3 : 2,
		databaseSkipped: !wantDatabase
	};
}

/**
 * Writes the cfw_do_sqlite driver into the mounted tree.
 *
 * The driver is not in the pack: the pack is generated from drupal-src, which is
 * the site as installed against core's sqlite driver. Shipping it as a separate
 * small asset avoids regenerating an 8 MB pack every time a driver class
 * changes.
 */
export async function mountDriver(
	binary: MountBinary,
	env: MountEnv,
	root = '/drupal'
): Promise<DriverMountResult> {
	const res = await env.ASSETS.fetch(new URL('https://a.local/driver.json'));
	if (!res.ok) {
		throw new Error(`driver.json not reachable: ${res.status}`);
	}
	const files = await res.json<Record<string, string>>();
	let bytes = 0;
	for (const [rel, source] of Object.entries(files)) {
		const full = `${root}/${rel}`;
		mkdirp(binary.FS, full.split('/').slice(0, -1).join('/'));
		binary.FS.writeFile(full, source);
		bytes += source.length;
	}
	return { files: Object.keys(files).length, bytes };
}
