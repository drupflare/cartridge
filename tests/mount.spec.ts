import { describe, expect, it } from 'vitest';
import { MountError } from '../src/errors.js';
import {
	createMemoryFS,
	mkdirp,
	mountDriver,
	mountDrupalStreaming,
	mountRecord,
	type MountFS
} from '../src/mount.js';
import { toUtf8 } from '../src/util.js';

/**
 * The mount surface, driven over a fake MEMFS.
 *
 * A fake FS, and the fake is the instrument. What every function here does is make a sequence of
 * `mkdir`/`writeFile`/`utime` calls, and the sequence IS the behaviour -- emscripten has no
 * `mkdir -p`, so a missing parent is an `ENOENT` at write time rather than at mount time, and the
 * fake reproduces exactly that so an unordered mount fails here.
 *
 * The two ASSETS-backed mounts are driven for real, not source-asserted: workerd has `Response`,
 * `CompressionStream` and `DecompressionStream`, so a fake `Fetcher` over a real gzip member
 * exercises the whole inflate-and-write path. `mountDrupalLazy()` is the one that stays
 * source-asserted in `lazy-fs.spec.ts`, because it patches MEMFS node internals that only a real
 * emscripten build provides.
 */

/** the three calls a mount makes, recorded */
interface FakeFs extends MountFS {
	dirs: string[];
	files: Map<string, Uint8Array>;
	utimes: Array<[string, number, number]>;
	failOn?: string;
}

function fakeFs(failOn?: string): FakeFs {
	const fs: FakeFs = {
		dirs: [],
		files: new Map(),
		utimes: [],
		failOn,
		mkdir(path: string): void {
			if (fs.dirs.includes(path)) throw new Error(`EEXIST: ${path}`);
			fs.dirs.push(path);
		},
		writeFile(path: string, data: Uint8Array | string): void {
			if (fs.failOn !== undefined && path === fs.failOn) {
				throw new Error(`EACCES: ${path}`);
			}
			const parent = path.slice(0, path.lastIndexOf('/'));
			// the real MEMFS raises ENOENT here, and reproducing that is the whole point of the fake
			if (parent !== '' && !fs.dirs.includes(parent)) {
				throw new Error(`ENOENT: no directory ${parent}`);
			}
			fs.files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
		},
		utime(path: string, atime: number, mtime: number): void {
			fs.utimes.push([path, atime, mtime]);
		}
	};
	return fs;
}

describe('mkdirp', () => {
	it('creates every segment, in order', () => {
		const fs = fakeFs();
		mkdirp(fs, '/a/b/c');
		expect(fs.dirs).toEqual(['/a', '/a/b', '/a/b/c']);
	});

	it('swallows an existing segment rather than failing the mount', () => {
		const fs = fakeFs();
		mkdirp(fs, '/a/b');
		mkdirp(fs, '/a/b/c');
		expect(fs.dirs).toEqual(['/a', '/a/b', '/a/b/c']);
	});

	it('ignores empty segments from a doubled or trailing slash', () => {
		const fs = fakeFs();
		mkdirp(fs, '//a//b/');
		expect(fs.dirs).toEqual(['/a', '/a/b']);
	});

	it('does nothing for the root', () => {
		const fs = fakeFs();
		mkdirp(fs, '/');
		expect(fs.dirs).toEqual([]);
	});
});

describe('mountRecord', () => {
	it('writes a string entry as UTF-8 bytes', () => {
		const fs = fakeFs();
		const result = mountRecord(fs, { '/scripts/main.php': '<?php echo 1;' });
		expect(result.files).toBe(1);
		expect(result.paths).toEqual(['/scripts/main.php']);
		expect(toUtf8(fs.files.get('/scripts/main.php')!)).toBe('<?php echo 1;');
	});

	it('writes a bytes entry unchanged', () => {
		const fs = fakeFs();
		const bytes = new Uint8Array([0, 1, 254, 255]);
		mountRecord(fs, { '/bin/blob': bytes });
		expect(fs.files.get('/bin/blob')).toEqual(bytes);
	});

	it('creates parent directories, which emscripten will not do', () => {
		const fs = fakeFs();
		mountRecord(fs, { '/deep/er/still/file.txt': 'x' });
		expect(fs.dirs).toEqual(['/deep', '/deep/er', '/deep/er/still']);
	});

	it('resolves a relative path under the root', () => {
		const fs = fakeFs();
		const result = mountRecord(fs, { 'lib/helper.py': 'pass' }, '/app');
		expect(result.paths).toEqual(['/app/lib/helper.py']);
	});

	it('leaves an absolute path alone even when a root is given', () => {
		const fs = fakeFs();
		const result = mountRecord(fs, { '/etc/thing': 'x' }, '/app');
		expect(result.paths).toEqual(['/etc/thing']);
	});

	it('tolerates a trailing slash on the root rather than doubling it', () => {
		const fs = fakeFs();
		const result = mountRecord(fs, { 'a.txt': 'x' }, '/app/');
		expect(result.paths).toEqual(['/app/a.txt']);
	});

	it('counts bytes, not entries, so a caller can bill a mount', () => {
		const fs = fakeFs();
		// 'cafe' plus a 2-byte e-acute is 5 bytes from a 4-character string
		const result = mountRecord(fs, { '/a': 'café', '/b': new Uint8Array(3) });
		expect(result.bytes).toBe(8);
		expect(result.files).toBe(2);
	});

	it('writes nothing and reports nothing for an empty record', () => {
		const fs = fakeFs();
		const result = mountRecord(fs, {});
		expect(result).toEqual({ files: 0, bytes: 0, paths: [] });
		expect(fs.files.size).toBe(0);
	});

	it('names the path when the FS refuses a write', () => {
		const fs = fakeFs('/locked/file');
		try {
			mountRecord(fs, { '/locked/file': 'x' });
			expect.unreachable('the fake FS refused this path');
		} catch (error) {
			expect(error).toBeInstanceOf(MountError);
			expect((error as MountError).code).toBe('mount.write_refused');
			// the path has to be in the message: "could not write" alone is unactionable
			expect((error as Error).message).toContain('/locked/file');
			expect((error as Error).message).toContain('EACCES');
		}
	});

	it('stops at the refusal rather than reporting a partial write as success', () => {
		const fs = fakeFs('/second');
		expect(() => mountRecord(fs, { '/first': 'a', '/second': 'b', '/third': 'c' })).toThrow(
			MountError
		);
		expect(fs.files.has('/first')).toBe(true);
		expect(fs.files.has('/third')).toBe(false);
	});
});

describe('createMemoryFS', () => {
	it('stores a string write and reads it back decoded', () => {
		const fs = createMemoryFS();
		mountRecord(fs, { '/cartridge/main.lua': 'print("hi")' });
		expect(fs.readText('/cartridge/main.lua')).toBe('print("hi")');
	});

	it('stores bytes unchanged and hands them back as bytes', () => {
		const fs = createMemoryFS();
		const bytes = new Uint8Array([0, 200, 255]);
		fs.writeFile('/bin/blob', bytes);
		expect(fs.read('/bin/blob')).toEqual(bytes);
	});

	it('answers undefined for a path nothing wrote, rather than an empty string', () => {
		// '' would be indistinguishable from a real empty file, and an adapter that evaluates '' runs
		// a script that was never written instead of reporting a missing one
		const fs = createMemoryFS();
		expect(fs.read('/nope')).toBeUndefined();
		expect(fs.readText('/nope')).toBeUndefined();
	});

	it('accepts a write under a directory nobody created', () => {
		// deliberately NOT the strict fake above: an adapter storing sources in a Map has no
		// directories to get wrong, and reproducing ENOENT here would only invent a failure mode
		const fs = createMemoryFS();
		expect(() => fs.writeFile('/never/mkdir-ed/file', 'x')).not.toThrow();
		expect(fs.readText('/never/mkdir-ed/file')).toBe('x');
	});

	it('satisfies MountFS, so mountRecord drives it with no adapter in between', () => {
		const fs = createMemoryFS();
		const result = mountRecord(fs, { 'lib/util.py': 'def helper(): pass' }, '/cartridge');
		expect(result.paths).toEqual(['/cartridge/lib/util.py']);
		expect(fs.files.size).toBe(1);
	});

	it('hands out a fresh map per call, so two interpreters cannot share sources', () => {
		const a = createMemoryFS();
		const b = createMemoryFS();
		a.writeFile('/x', 'from a');
		expect(b.read('/x')).toBeUndefined();
	});
});

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

/** gzips bytes with the platform's own stream, so the mount inflates a real member */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('mountDrupalStreaming', () => {
	/** three files concatenated, plus the index that offsets into the inflated stream */
	async function pack() {
		const parts = ['alpha', 'bravo!', 'charlie'];
		const joined = new TextEncoder().encode(parts.join(''));
		let offset = 0;
		const index = parts.map((part, i) => {
			const entry = { p: `dir${i}/f${i}.txt`, o: offset, l: part.length, m: 1700000000 + i };
			offset += part.length;
			return entry;
		});
		return { index, gz: await gzip(joined) };
	}

	it('writes every member with its own bytes, and reports the totals', async () => {
		const { index, gz } = await pack();
		const fs = fakeFs();
		const env = assets({
			'/drupal/core.json': JSON.stringify(index),
			'/drupal/core.bin.gz': gz
		});
		const result = await mountDrupalStreaming({ FS: fs }, env, { database: false });

		expect(result.mode).toBe('streaming');
		expect(result.files).toBe(3);
		expect(result.bytes).toBe(18);
		expect(toUtf8(fs.files.get('/drupal/dir0/f0.txt')!)).toBe('alpha');
		expect(toUtf8(fs.files.get('/drupal/dir2/f2.txt')!)).toBe('charlie');
	});

	it('sets mtimes, because a compiled-template cache key is hashed from filemtime()', async () => {
		const { index, gz } = await pack();
		const fs = fakeFs();
		await mountDrupalStreaming(
			{ FS: fs },
			assets({ '/drupal/core.json': JSON.stringify(index), '/drupal/core.bin.gz': gz }),
			{ database: false }
		);
		expect(fs.utimes).toContainEqual(['/drupal/dir0/f0.txt', 1700000000, 1700000000]);
	});

	it('mounts through an FS that has no utime at all', async () => {
		// wasmoon's Lua 5.4 build is exactly this: a real emscripten FS with mkdir and writeFile and
		// `typeof FS.utime === 'undefined'`. A required member would have excluded a build this
		// package otherwise drives end to end, so the call is optional and the mount still lands
		const { index, gz } = await pack();
		const fs = fakeFs();
		const withoutUtime: MountFS = { mkdir: fs.mkdir, writeFile: fs.writeFile };
		await mountDrupalStreaming(
			{ FS: withoutUtime },
			assets({ '/drupal/core.json': JSON.stringify(index), '/drupal/core.bin.gz': gz }),
			{ database: false }
		);
		expect(toUtf8(fs.files.get('/drupal/dir0/f0.txt')!)).toBe('alpha');
		expect(fs.utimes).toEqual([]);
	});

	it('keeps the carry flat rather than holding the whole inflated tree', async () => {
		const { index, gz } = await pack();
		const result = await mountDrupalStreaming(
			{ FS: fakeFs() },
			assets({ '/drupal/core.json': JSON.stringify(index), '/drupal/core.bin.gz': gz }),
			{ database: false }
		);
		// the naive version holds the compressed blob, the inflated buffer and the MEMFS copies at
		// once, which peaked at 145-157 MB against a 128 MB isolate cap
		expect(result.peakCarryBytes).toBeLessThanOrEqual(18);
	});

	it('spends 2 subrequests without the database and 3 with it', async () => {
		const { index, gz } = await pack();
		const bodies = {
			'/drupal/core.json': JSON.stringify(index),
			'/drupal/core.bin.gz': gz,
			'/drupal/site.sqlite': new Uint8Array([1, 2, 3, 4])
		};
		const without = await mountDrupalStreaming({ FS: fakeFs() }, assets(bodies), {
			database: false
		});
		expect(without.subrequests).toBe(2);
		expect(without.databaseSkipped).toBe(true);
		expect(without.dbBytes).toBe(0);

		const withDb = await mountDrupalStreaming({ FS: fakeFs() }, assets(bodies));
		expect(withDb.subrequests).toBe(3);
		expect(withDb.dbBytes).toBe(4);
	});

	it('reads the database from a DIFFERENT prefix when asked', async () => {
		const { index, gz } = await pack();
		const env = assets({
			'/drupal/core.json': JSON.stringify(index),
			'/drupal/core.bin.gz': gz,
			'/drupal-std/site.sqlite': new Uint8Array(9)
		});
		// the code tree and the site database can come from separate packs; one has no node.type.*
		// config at all, so no content can be created on it
		const result = await mountDrupalStreaming({ FS: fakeFs() }, env, {
			dbPrefix: 'drupal-std'
		});
		expect(result.dbPrefix).toBe('drupal-std');
		expect(result.dbBytes).toBe(9);
		expect(env.asked).toContain('/drupal-std/site.sqlite');
	});

	it('skips an absolute path in the index rather than writing outside the root', async () => {
		const joined = new TextEncoder().encode('xy');
		const index = [
			{ p: '/etc/passwd', o: 0, l: 1 },
			{ p: 'ok.txt', o: 1, l: 1 }
		];
		const fs = fakeFs();
		await mountDrupalStreaming(
			{ FS: fs },
			assets({
				'/drupal/core.json': JSON.stringify(index),
				'/drupal/core.bin.gz': await gzip(joined)
			}),
			{ database: false }
		);
		expect(fs.files.has('/etc/passwd')).toBe(false);
		expect(fs.files.has('/drupal/ok.txt')).toBe(true);
	});

	it('names both statuses when the pack is not reachable from this context', async () => {
		await expect(
			mountDrupalStreaming({ FS: fakeFs() }, assets({}), { database: false })
		).rejects.toThrow(/core\.json 404, core\.bin\.gz 404/);
	});

	it('stops short rather than writing a truncated member when the stream ends early', async () => {
		// the index claims 20 bytes; the stream carries 2
		const index = [{ p: 'short.txt', o: 0, l: 20 }];
		const fs = fakeFs();
		const result = await mountDrupalStreaming(
			{ FS: fs },
			assets({
				'/drupal/core.json': JSON.stringify(index),
				'/drupal/core.bin.gz': await gzip(new TextEncoder().encode('xy'))
			}),
			{ database: false }
		);
		expect(fs.files.has('/drupal/short.txt')).toBe(false);
		expect(result.bytes).toBe(0);
	});
});

describe('mountDriver', () => {
	it('writes each driver file under the root and reports the totals', async () => {
		const fs = fakeFs();
		const env = assets({
			'/driver.json': JSON.stringify({
				'core/lib/Driver/Connection.php': '<?php class Connection {}',
				'core/lib/Driver/Statement.php': '<?php class Statement {}'
			})
		});
		const result = await mountDriver({ FS: fs }, env);
		expect(result.files).toBe(2);
		expect(result.bytes).toBe(49);
		expect(toUtf8(fs.files.get('/drupal/core/lib/Driver/Connection.php')!)).toContain(
			'Connection'
		);
	});

	it('honours a different root', async () => {
		const fs = fakeFs();
		const env = assets({ '/driver.json': JSON.stringify({ 'a/b.php': 'x' }) });
		await mountDriver({ FS: fs }, env, '/elsewhere');
		expect(fs.files.has('/elsewhere/a/b.php')).toBe(true);
	});

	it('names the status when driver.json is not reachable', async () => {
		await expect(mountDriver({ FS: fakeFs() }, assets({}))).rejects.toThrow(
			'driver.json not reachable: 404'
		);
	});
});
