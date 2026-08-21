import { describe, expect, it } from 'vitest';
import tailWorker, {
	canaryObservations,
	evaluateCanary,
	reduceEvent,
	summarize,
	type TailEnv,
	type TraceEvent,
	type TraceException,
	type TraceLog
} from '../src/tail-worker.js';

/** the default export's one method, bound so the handler reads as a function in the specs */
const tail = (events: TraceEvent[], env?: TailEnv) => tailWorker.tail(events, env);

/**
 * Ported from `scripts/test-tail-worker.mjs` (26 hand-rolled assertions).
 *
 * The Tail Worker decides whether the CPU-attribution finding still holds, and that is the
 * thing this project has the most riding on: the whole slicing design assumes work parked
 * in one Durable Object invocation is charged to the invocation that RESUMES it. So the
 * verdict logic is tested against synthetic trace events here rather than only being
 * exercised by a deploy.
 *
 * Every group keeps its control. A batch where attribution has moved back to the
 * originating invocation must be reported as a failure, or a green canary means nothing.
 */

/** a trace event in the shape `wrangler tail --format json` emits */
function event({
	url,
	model = 'durableObject',
	cpu = 0,
	wall = 0,
	outcome = 'ok',
	logs = [] as TraceLog[],
	exceptions = [] as TraceException[],
	scheduled = false
}: {
	url?: string;
	model?: string;
	cpu?: number;
	wall?: number;
	outcome?: string;
	logs?: TraceLog[];
	exceptions?: TraceException[];
	scheduled?: boolean;
}) {
	return {
		executionModel: model,
		entrypoint: model === 'durableObject' ? 'AttributionDurableObject' : undefined,
		outcome,
		cpuTime: cpu,
		wallTime: wall,
		exceptions,
		logs,
		event: scheduled ? { scheduledTime: 1 } : { request: { url }, response: { status: 200 } }
	};
}

describe('reduceEvent', () => {
	it('keeps cpuTime, which is the only authoritative absolute', () => {
		const r = reduceEvent(
			event({ url: 'https://x.workers.dev/serve?site=a&path=/', cpu: 46, wall: 900 })
		);
		expect(r.cpuTime).toBe(46);
	});

	it('splits the path from the query', () => {
		const r = reduceEvent(event({ url: 'https://x.workers.dev/serve?site=a&path=/', cpu: 46 }));
		expect(r.path).toBe('/serve');
		expect(r.search).toBe('?site=a&path=/');
	});

	it('labels an alarm rather than dropping it, since it has no request', () => {
		expect(reduceEvent(event({ scheduled: true, cpu: 5 })).path).toBe('(alarm)');
	});

	it('does not throw on a malformed url', () => {
		expect(reduceEvent(event({ url: 'not a url', cpu: 1 })).path).toBe('(none)');
	});

	it('picks a CfwLogger line out of the console output', () => {
		const r = reduceEvent(
			event({
				url: 'https://x.workers.dev/serve',
				logs: [
					{ message: ['{"cfw":"php","level":"error","message":"boom"}'] },
					{ message: ['an unrelated console.log'] }
				]
			})
		);
		expect(r.phpLogs).toHaveLength(1);
		expect(r.phpLogs[0]?.message).toBe('boom');
		// the control: an unrelated console.log must not be mistaken for a Drupal log entry
		expect(r.phpLogs.every((l: { cfw?: string }) => l.cfw === 'php')).toBe(true);
	});
});

describe('summarize', () => {
	const batch = [
		event({ url: 'https://x/serve?path=/', model: 'stateless', cpu: 2 }),
		event({ url: 'https://x/__serve?path=/', cpu: 46 }),
		event({ url: 'https://x/__serve?path=/b', cpu: 8 }),
		event({ scheduled: true, cpu: 5 }),
		event({
			url: 'https://x/__serve?path=/c',
			cpu: 3,
			outcome: 'exceededCpu',
			exceptions: [{ name: 'Error', message: 'over' }]
		})
	];

	it('counts every event', () => expect(summarize(batch).events).toBe(5));

	it('separates the stateless hop from the Durable Object', () => {
		const s = summarize(batch);
		expect(s.byModel.stateless?.n).toBe(1);
		expect(s.byModel.durableObject?.n).toBe(4);
	});

	it('reports the worst invocation, which is what a budget breach looks like', () => {
		expect(summarize(batch).worst?.cpuTime).toBe(46);
	});

	it('counts invocations over the 10 ms free ceiling', () => {
		expect(summarize(batch).overFreeCeiling).toBe(1);
	});

	it('surfaces exceptions', () => {
		const s = summarize(batch);
		expect(s.exceptions).toHaveLength(1);
		expect(s.exceptions[0]).toContain('over');
	});

	it('counts non-ok outcomes per model', () => {
		expect(summarize(batch).byModel.durableObject?.notOk).toBe(1);
	});

	it('summarizes an empty batch to nothing rather than throwing', () => {
		expect(summarize([]).events).toBe(0);
	});
});

describe('canaryObservations', () => {
	const canaryBatch = [
		event({ url: 'https://x/park?canary=abc&leg=park', cpu: 2 }),
		event({ url: 'https://x/park?canary=abc&leg=park', model: 'stateless', cpu: 1 }),
		event({ url: 'https://x/resume?canary=abc&leg=resume', cpu: 88 }),
		event({ url: 'https://x/oneshot?canary=abc&leg=oneshot', cpu: 93 }),
		event({ url: 'https://x/__serve?path=/', cpu: 46 })
	];

	it('observes only the tagged legs', () => {
		expect(canaryObservations(canaryBatch)).toHaveLength(3);
	});

	it('excludes the stateless hop, which is not the invocation being charged', () => {
		expect(canaryObservations(canaryBatch).every((o) => o.cpuTime !== 1)).toBe(true);
	});

	it('identifies a leg from the url, not from arrival order', () => {
		const legs = canaryObservations(canaryBatch)
			.map((o) => o.leg)
			.sort()
			.join(',');
		expect(legs).toBe('oneshot,park,resume');
	});

	it('ignores an untagged request', () => {
		expect(canaryObservations(canaryBatch).some((o) => o.cpuTime === 46)).toBe(false);
	});
});

describe('evaluateCanary: the verdict and its control', () => {
	it('passes on the real measured 2/88/93 result', () => {
		const good = evaluateCanary({ park: 2, resume: 88, oneshot: 93 });
		expect(good.ok).toBe(true);
		// and it says WHY, rather than only that it passed
		expect(good.attribution).toBe(true);
		expect(good.reconciles).toBe(true);
	});

	// the control: if attribution moved back to the originating invocation, the parker would
	// be charged and the resumer would be cheap -- the shape that kills slicing.
	it('FAILS when attribution moves to the originating invocation', () => {
		const moved = evaluateCanary({ park: 90, resume: 3, oneshot: 93 });
		expect(moved.ok).toBe(false);
		expect(moved.reason).toContain('kills slicing');
	});

	it('fails the reconciliation half when work is double-charged', () => {
		expect(evaluateCanary({ park: 93, resume: 93, oneshot: 93 }).ok).toBe(false);
	});

	it('fails reconciliation when work vanishes', () => {
		expect(evaluateCanary({ park: 2, resume: 10, oneshot: 93 }).ok).toBe(false);
	});

	it('reports an incomplete run as incomplete, not as a failure of the finding', () => {
		expect(evaluateCanary({ park: 2, resume: 88 }).reason).toContain('incomplete');
	});

	it('refuses a control that burned no CPU rather than dividing by it', () => {
		expect(evaluateCanary({ park: 0, resume: 0, oneshot: 0 }).reason).toContain('no CPU');
	});

	// absolute cpuTime varies by colo -- 46 ms on one deploy, 75 on another -- so the
	// thresholds have to be ratios
	it('is scale-free, so a slower colo still passes', () => {
		expect(evaluateCanary({ park: 5, resume: 210, oneshot: 230 }).ok).toBe(true);
	});
});

describe('tail(): the handler, and the correlation that makes a verdict', () => {
	/** captures console output, since the log line IS the Tail Worker's primary record */
	function captureConsole() {
		const logs: string[] = [];
		const errors: string[] = [];
		const realLog = console.log;
		const realError = console.error;
		console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
		console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
		return {
			logs,
			errors,
			restore: () => {
				console.log = realLog;
				console.error = realError;
			}
		};
	}

	/** the three legs of one canary run, as three separate trace events */
	const legs = (id: string, park: number, resume: number, oneshot: number) => [
		event({ url: `https://x.workers.dev/probe?canary=${id}&leg=park`, cpu: park }),
		event({ url: `https://x.workers.dev/probe?canary=${id}&leg=resume`, cpu: resume }),
		event({ url: `https://x.workers.dev/probe?canary=${id}&leg=oneshot`, cpu: oneshot })
	];

	it('emits one summary line per non-empty batch', async () => {
		const con = captureConsole();
		try {
			await tail([event({ url: 'https://x.workers.dev/serve', cpu: 12 })]);
		} finally {
			con.restore();
		}
		expect(con.logs).toHaveLength(1);
		const summary = JSON.parse(con.logs[0] as string);
		expect(summary.cfwTail).toBe('summary');
		expect(summary.events).toBe(1);
		// 12 ms is over the free ceiling, and the summary is where that gets named
		expect(summary.overFreeCeiling).toBe(1);
	});

	it('says nothing at all for an empty batch, rather than logging a zero', async () => {
		const con = captureConsole();
		try {
			await tail([]);
		} finally {
			con.restore();
		}
		expect(con.logs).toEqual([]);
		expect(con.errors).toEqual([]);
	});

	it('re-emits a PHP error line at the top level so it is greppable', async () => {
		const con = captureConsole();
		try {
			await tail([
				event({
					url: 'https://x.workers.dev/serve',
					logs: [
						{
							message: [
								JSON.stringify({ cfw: 'php', level: 'error', message: 'boom' })
							]
						}
					]
				})
			]);
		} finally {
			con.restore();
		}
		expect(con.errors).toHaveLength(1);
		const line = JSON.parse(con.errors[0] as string);
		expect(line.cfwTail).toBe('php-error');
		expect(line.message).toBe('boom');
	});

	it('leaves a non-error PHP line inside the summary rather than re-emitting it', async () => {
		const con = captureConsole();
		try {
			await tail([
				event({
					url: 'https://x.workers.dev/serve',
					logs: [
						{
							message: [
								JSON.stringify({ cfw: 'php', level: 'warning', message: 'hm' })
							]
						}
					]
				})
			]);
		} finally {
			con.restore();
		}
		expect(con.errors).toEqual([]);
		expect(JSON.parse(con.logs[0] as string).phpLogs).toHaveLength(1);
	});

	it('logs a passing canary verdict once all three legs have been seen', async () => {
		const con = captureConsole();
		try {
			// the real measured 2/88/93 result
			await tail(legs('pass01', 2, 88, 93));
		} finally {
			con.restore();
		}
		const verdict = con.logs.map((l) => JSON.parse(l)).find((l) => l.cfwTail === 'canary');
		expect(verdict.ok).toBe(true);
		expect(verdict.id).toBe('pass01');
		expect(con.errors).toEqual([]);
	});

	it('logs a FAILED canary to console.error, because that is the platform moving', async () => {
		const con = captureConsole();
		try {
			// attribution back on the originating invocation kills slicing
			await tail(legs('fail01', 88, 2, 93));
		} finally {
			con.restore();
		}
		const verdict = con.errors.map((l) => JSON.parse(l)).find((l) => l.cfwTail === 'canary');
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('did not dominate');
	});

	it('correlates legs across SPLIT batches, since a tail batch is not ordered or whole', async () => {
		const con = captureConsole();
		try {
			await tail([legs('split1', 2, 88, 93)[0]!]);
			await tail([legs('split1', 2, 88, 93)[2]!]);
			// no verdict yet: two of three legs
			expect(con.logs.filter((l) => l.includes('"canary"'))).toHaveLength(0);
			await tail([legs('split1', 2, 88, 93)[1]!]);
		} finally {
			con.restore();
		}
		const verdict = con.logs.map((l) => JSON.parse(l)).find((l) => l.cfwTail === 'canary');
		expect(verdict?.ok).toBe(true);
	});

	it('posts the verdict to CANARY_SINK when one is bound', async () => {
		const posted: string[] = [];
		const env = {
			CANARY_SINK: {
				idFromName: (name: string) => name,
				get: () => ({
					fetch: async (_url: string, init?: { body?: string }) => {
						posted.push(String(init?.body));
						return new Response('ok');
					}
				})
			} as unknown as DurableObjectNamespace
		};
		const con = captureConsole();
		try {
			await tail(legs('sink01', 2, 88, 93), env);
		} finally {
			con.restore();
		}
		expect(posted).toHaveLength(1);
		expect(JSON.parse(posted[0] as string).cfwTail).toBe('canary');
	});

	it('treats a sink failure as a convenience lost, not a batch lost', async () => {
		const env = {
			CANARY_SINK: {
				idFromName: (name: string) => name,
				get: () => ({
					fetch: async () => {
						throw new Error('sink unreachable');
					}
				})
			} as unknown as DurableObjectNamespace
		};
		const con = captureConsole();
		try {
			// the log line is the primary record, so this must not reject
			await expect(tail(legs('sink02', 2, 88, 93), env)).resolves.toBeUndefined();
		} finally {
			con.restore();
		}
		expect(con.logs.some((l) => l.includes('"canary"'))).toBe(true);
	});
});
