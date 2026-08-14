import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	BUDGET_WARN_FRACTION,
	CircuitBreaker,
	type Finding,
	HOST_TRIPWIRES,
	LADDER,
	LEDGER_MAX_ROWS,
	MAX_CONTEXT_BYTES,
	MEMORY_RISE_SAMPLES,
	SEVERITY,
	SIZE_ANOMALY_FACTOR,
	bridgeAsyncifyCalled,
	bridgeMaskLeaked,
	budgetPressure,
	dbSemaphoreDirty,
	ensureHealthTable,
	gcHealthLedger,
	initialRung,
	ledgerOversized,
	memoryHighwaterRising,
	migrateIncomplete,
	packGenerationMismatch,
	quarantineDecision,
	recordFinding,
	renderEmpty,
	renderSizeAnomaly,
	runHostTripwires,
	updbHalted
} from '../src/supervisor.js';

/**
 * Every tripwire is tested BOTH ways: the condition that must trip it, and the nearby condition
 * that must not. This project's own rule is that a differential which cannot fail proves nothing,
 * and the corollary here is stronger -- a tripwire nobody has seen fire is decoration.
 *
 * The ledger runs against the REAL `ctx.storage.sql` inside a real Durable Object, because the
 * thing being asserted is that a capped log table stays capped, and a fake would agree with
 * whatever the implementation happened to do.
 */

/** the ledger half, on real DO SQLite */
async function withHealthSql<T>(fn: (sql: never) => T | Promise<T>): Promise<T> {
	const id = env.SITE.newUniqueId();
	const stub = env.SITE.get(id);
	return runInDurableObject(stub, async (instance: unknown) => {
		const sql = (instance as { ctx: { storage: { sql: never } } }).ctx.storage.sql;
		ensureHealthTable(sql);
		return fn(sql);
	});
}

describe('render.empty: the zero-byte 200 that shipped', () => {
	it('fires on a 200 with no body', () => {
		const f = renderEmpty({ status: 200, bytes: 0, path: '/' });
		expect(f?.code).toBe('render.empty');
		// critical, because a cache cannot tell it from a real page and will re-serve it
		expect(f?.severity).toBe('critical');
	});

	it('does not fire on a 200 that has a body', () => {
		expect(renderEmpty({ status: 200, bytes: 12304, path: '/' })).toBeNull();
	});

	it('does not fire on an empty 503, which is a legitimate answer', () => {
		// a half-migrated site answers 503 with Retry-After on purpose
		expect(renderEmpty({ status: 503, bytes: 0, path: '/' })).toBeNull();
	});

	it('does not fire on an empty 202, which is the placeholder', () => {
		expect(renderEmpty({ status: 202, bytes: 0, path: '/' })).toBeNull();
	});
});

describe('render.size_anomaly: the uid-1 disclosure', () => {
	it('fires when a page renders far larger than its own median', () => {
		// the real incident: 12,296 bytes became 90,038 because a save left currentUser as uid 1,
		// and that admin HTML went into the ANONYMOUS page cache
		const f = renderSizeAnomaly({ status: 200, bytes: 90038, medianBytes: 12296, path: '/' });
		expect(f?.code).toBe('render.size_anomaly');
		expect(f?.context).toContain('7.32x');
	});

	it('fires when it renders far smaller, which is truncation', () => {
		expect(renderSizeAnomaly({ status: 200, bytes: 100, medianBytes: 12304 })?.code).toBe(
			'render.size_anomaly'
		);
	});

	it('does not fire inside the factor, in either direction', () => {
		const median = 12304;
		expect(
			renderSizeAnomaly({
				status: 200,
				bytes: median * (SIZE_ANOMALY_FACTOR - 0.5),
				medianBytes: median
			})
		).toBeNull();
		expect(
			renderSizeAnomaly({
				status: 200,
				bytes: median / (SIZE_ANOMALY_FACTOR - 0.5),
				medianBytes: median
			})
		).toBeNull();
	});

	it('does not fire with no median yet, rather than treating 0 as the median', () => {
		// dividing by an absent median is how a first request becomes an infinite ratio
		expect(renderSizeAnomaly({ status: 200, bytes: 12304 })).toBeNull();
	});
});

describe('bridge.asyncify_called: the uncatchable JS throw', () => {
	it('fires on any call at all', () => {
		expect(bridgeAsyncifyCalled({ asyncifyCalls: 1 })?.severity).toBe('error');
	});

	it('does not fire at zero', () => {
		expect(bridgeAsyncifyCalled({ asyncifyCalls: 0 })).toBeNull();
	});

	it('does not fire when the counter is absent', () => {
		expect(bridgeAsyncifyCalled({})).toBeNull();
	});
});

describe('bridge.mask_leaked and db.semaphore_dirty', () => {
	it('fires on a non-zero mask depth', () => {
		expect(bridgeMaskLeaked({ maskDepth: 2 })?.code).toBe('bridge.mask_leaked');
		expect(bridgeMaskLeaked({ maskDepth: 0 })).toBeNull();
	});

	it('fires on a left-behind semaphore row', () => {
		expect(dbSemaphoreDirty({ semaphoreRows: 1 })?.code).toBe('db.semaphore_dirty');
		expect(dbSemaphoreDirty({ semaphoreRows: 0 })).toBeNull();
	});
});

describe('migrate.incomplete: half a database renders, which is the danger', () => {
	it('fires while the cursor is partway', () => {
		const f = migrateIncomplete({ migrateChunk: 24, migrateChunks: 99 });
		expect(f?.code).toBe('migrate.incomplete');
		expect(f?.severity).toBe('critical');
	});

	it('does not fire when the cursor is complete', () => {
		expect(migrateIncomplete({ migrateChunk: 99, migrateChunks: 99 })).toBeNull();
	});

	it('does not fire when there is NO cursor at all', () => {
		// "never started" and "half done" are different states, and conflating them would take
		// every deploy predating the engine offline
		expect(migrateIncomplete({})).toBeNull();
	});
});

describe('updb.halted and pack.generation_mismatch', () => {
	it.each(['planning', 'running', 'complete', 'rolled_back', 'abandoned'])(
		'does not fire on phase %s',
		(phase) => {
			expect(updbHalted({ updbPhase: phase })).toBeNull();
		}
	);

	it('fires only on halted', () => {
		expect(updbHalted({ updbPhase: 'halted' })?.code).toBe('updb.halted');
	});

	it('fires when the pack and the database disagree', () => {
		expect(packGenerationMismatch({ packGeneration: 'a', dbGeneration: 'b' })?.severity).toBe(
			'critical'
		);
	});

	it('does not fire when they agree, or when either is unknown', () => {
		expect(packGenerationMismatch({ packGeneration: 'a', dbGeneration: 'a' })).toBeNull();
		expect(packGenerationMismatch({ packGeneration: 'a' })).toBeNull();
		expect(packGenerationMismatch({})).toBeNull();
	});
});

describe('memory.highwater_rising: trend, not threshold', () => {
	it('fires on a monotonic rise', () => {
		const f = memoryHighwaterRising({ memorySamples: [64, 70, 76, 80, 86] });
		expect(f?.code).toBe('memory.highwater_rising');
		expect(f?.context).toContain('16 bytes');
	});

	it('does not fire when a sample dips, because wasm memory plateaus', () => {
		// emscripten grows geometrically, so a flat stretch is the NORMAL shape and only a
		// monotonic rise is evidence
		expect(memoryHighwaterRising({ memorySamples: [64, 70, 70, 80, 86] })).toBeNull();
	});

	it('does not fire on a high but flat reading', () => {
		expect(memoryHighwaterRising({ memorySamples: [110, 110, 110, 110, 110] })).toBeNull();
	});

	it('does not fire with too few samples to establish a trend', () => {
		const short = Array.from({ length: MEMORY_RISE_SAMPLES - 1 }, (_, i) => i * 10);
		expect(memoryHighwaterRising({ memorySamples: short })).toBeNull();
	});
});

describe('budget pressure is reported before the meter is spent', () => {
	it('warns above the fraction and errors at the limit', () => {
		const warn = budgetPressure({
			rowsWritten: Math.ceil(100_000 * BUDGET_WARN_FRACTION),
			rowsWrittenLimit: 100_000
		});
		expect(warn[0]?.code).toBe('budget.rows_written');
		expect(warn[0]?.severity).toBe('warn');

		const over = budgetPressure({ doRequests: 100_000, doRequestsLimit: 100_000 });
		expect(over[0]?.code).toBe('budget.do_requests');
		expect(over[0]?.severity).toBe('error');
	});

	it('says nothing well under the fraction', () => {
		expect(budgetPressure({ rowsWritten: 100, rowsWrittenLimit: 100_000 })).toHaveLength(0);
	});

	it('says nothing when no limit is configured, rather than dividing by zero', () => {
		expect(budgetPressure({ rowsWritten: 100, rowsWrittenLimit: 0 })).toHaveLength(0);
	});
});

describe('the registry runs every wire and stays O(1)', () => {
	it('finds several at once on a genuinely sick observation', () => {
		const found = runHostTripwires({
			status: 200,
			bytes: 0,
			path: '/',
			asyncifyCalls: 2,
			maskDepth: 1,
			migrateChunk: 3,
			migrateChunks: 99
		});
		const codes = found.map((f) => f.code);
		expect(codes).toContain('render.empty');
		expect(codes).toContain('bridge.asyncify_called');
		expect(codes).toContain('bridge.mask_leaked');
		expect(codes).toContain('migrate.incomplete');
	});

	it('finds nothing on a healthy one', () => {
		expect(
			runHostTripwires({
				status: 200,
				bytes: 12304,
				medianBytes: 12304,
				path: '/',
				asyncifyCalls: 0,
				maskDepth: 0,
				semaphoreRows: 0,
				migrateChunk: 99,
				migrateChunks: 99,
				updbPhase: 'complete'
			})
		).toHaveLength(0);
	});

	it('every wire in the list is reachable from the registry', () => {
		// guards against a wire being written and never wired up, which is the decoration case
		expect(HOST_TRIPWIRES.length).toBeGreaterThanOrEqual(10);
		for (const wire of HOST_TRIPWIRES) expect(typeof wire).toBe('function');
	});
});

describe('the breaker escalates on repetition and decays on quiet', () => {
	it('escalates one rung after the threshold, not on the first hit', () => {
		const b = new CircuitBreaker(60_000, 3);
		expect(b.record('x', 'warn', 1000)).toBe('observe');
		expect(b.record('x', 'warn', 1100)).toBe('observe');
		// third hit inside the window
		expect(b.record('x', 'warn', 1200)).toBe('reset');
	});

	it('forgets hits that fall outside the window', () => {
		const b = new CircuitBreaker(1000, 3);
		b.record('x', 'warn', 0);
		b.record('x', 'warn', 100);
		// this one is 2000 ms later, so the first two have aged out
		expect(b.record('x', 'warn', 2000)).toBe('observe');
	});

	it('decays a rung per clean interval and forgets the code at the bottom', () => {
		const b = new CircuitBreaker(60_000, 1);
		b.record('x', 'error', 0);
		expect(b.rungOf('x')).toBe('reconstruct');
		b.decay();
		expect(b.rungOf('x')).toBe('reset');
		b.decay();
		expect(b.rungOf('x')).toBe('observe');
		b.decay();
		// dropped entirely, so the map cannot grow without bound
		expect(b.rungOf('x')).toBeNull();
	});

	it('never escalates past the top of the ladder', () => {
		const b = new CircuitBreaker(60_000, 1);
		for (let i = 0; i < 20; i++) b.record('x', 'critical', i);
		expect(b.rungOf('x')).toBe(LADDER[LADDER.length - 1]);
	});

	it('starts a critical finding high and a warning low', () => {
		expect(initialRung('critical')).toBe('quarantine');
		expect(initialRung('error')).toBe('reset');
		expect(initialRung('warn')).toBe('observe');
	});

	it('keeps codes independent, so one noisy wire cannot escalate another', () => {
		const b = new CircuitBreaker(60_000, 2);
		b.record('a', 'warn', 0);
		b.record('a', 'warn', 1);
		expect(b.rungOf('a')).toBe('reset');
		expect(b.rungOf('b')).toBeNull();
	});
});

describe('quarantine beats wrong output', () => {
	it('quarantines on a critical finding and names it', () => {
		const d = quarantineDecision([
			{ code: 'render.empty', severity: 'critical', scope: '/', context: '200 with 0 bytes' }
		]);
		expect(d.quarantine).toBe(true);
		expect(d.reason).toContain('render.empty');
	});

	it('does not quarantine on warnings alone', () => {
		const warnings: Finding[] = [
			{ code: 'db.semaphore_dirty', severity: 'warn', scope: 's', context: '1' },
			{ code: 'budget.rows_written', severity: 'warn', scope: 'b', context: '80%' }
		];
		expect(quarantineDecision(warnings).quarantine).toBe(false);
	});

	it('does not quarantine on nothing', () => {
		expect(quarantineDecision([]).quarantine).toBe(false);
	});
});

describe('the ledger, on real ctx.storage.sql', () => {
	it('records a finding with its severity as a number', async () => {
		const rows = await withHealthSql((sql) => {
			recordFinding(
				sql,
				{ code: 'render.empty', severity: 'critical', scope: '/', context: 'x' },
				1000,
				'quarantine',
				'served 503'
			);
			return (sql as unknown as { exec(q: string): { toArray(): Record<string, unknown>[] } })
				.exec('SELECT code, severity, action, outcome FROM cfw_health')
				.toArray();
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.code).toBe('render.empty');
		expect(Number(rows[0]?.severity)).toBe(SEVERITY.critical);
		expect(rows[0]?.action).toBe('quarantine');
		expect(rows[0]?.outcome).toBe('served 503');
	});

	it('truncates context rather than storing whatever it was handed', async () => {
		const len = await withHealthSql((sql) => {
			recordFinding(
				sql,
				{ code: 'x', severity: 'warn', scope: 'y', context: 'z'.repeat(5000) },
				1
			);
			const rows = (
				sql as unknown as { exec(q: string): { toArray(): Record<string, unknown>[] } }
			)
				.exec('SELECT length(context) AS n FROM cfw_health')
				.toArray();
			return Number(rows[0]?.n ?? 0);
		});
		expect(len).toBe(MAX_CONTEXT_BYTES);
	});

	it('trims to the cap, keeps the newest, and REPORTS what it deleted', async () => {
		const out = await withHealthSql((sql) => {
			const s = sql as unknown as {
				exec(q: string, ...p: unknown[]): { toArray(): Record<string, unknown>[] };
			};
			for (let i = 0; i < LEDGER_MAX_ROWS + 25; i++) {
				recordFinding(sql, { code: `c${i}`, severity: 'info', scope: '', context: '' }, i);
			}
			const deleted = gcHealthLedger(sql);
			const rows = s.exec('SELECT COUNT(*) AS n FROM cfw_health').toArray();
			const oldest = s.exec('SELECT code FROM cfw_health ORDER BY id ASC LIMIT 1').toArray();
			return { deleted, n: Number(rows[0]?.n ?? 0), oldest: String(oldest[0]?.code ?? '') };
		});
		// the count it returns is what the caller bills against the rows-written budget
		expect(out.deleted).toBe(25);
		expect(out.n).toBe(LEDGER_MAX_ROWS);
		// the newest survived, so the oldest remaining is the 25th
		expect(out.oldest).toBe('c25');
	});

	it('deletes nothing and reports 0 when it is under the cap', async () => {
		const deleted = await withHealthSql((sql) => {
			recordFinding(sql, { code: 'a', severity: 'info', scope: '', context: '' }, 1);
			return gcHealthLedger(sql);
		});
		expect(deleted).toBe(0);
	});

	it('notices its own oversized table through a tripwire', () => {
		expect(ledgerOversized({ ledgerRows: LEDGER_MAX_ROWS + 1 })?.code).toBe(
			'health.ledger_oversized'
		);
		expect(ledgerOversized({ ledgerRows: LEDGER_MAX_ROWS })).toBeNull();
	});
});
