/**
 * Tail Worker: reads the producer's own trace events, including `cpuTime`.
 *
 * The CPU-attribution result the whole slicing design
 * rests on is undocumented behaviour: work parked in one Durable Object invocation
 * and resumed in another is charged to the RESUMING invocation. If Cloudflare
 * changes that, nothing in the product fails loudly -- renders just stop fitting.
 * So the canary re-runs the three-invocation probe and this Worker checks the
 * invariant against the cpuTime it observes, which is the only place the numbers are
 * visible.
 *
 * The pure functions are exported and driven by scripts/test-tail-worker.mjs, so the
 * verdict logic is a gate test rather than something only a deploy can check.
 */

/** how long an incomplete canary observation is kept before it is abandoned */
const CANARY_TTL_MS = 120000;

/** one entry of a trace event's `exceptions` array */
export interface TraceException {
	name?: string;
	message?: string;
}

/** one console line; `message` is the `console.log` argument list, so anything can be in it */
export interface TraceLog {
	message?: unknown[];
}

/** a trace event's `event` member: a request, or a `scheduledTime` when an alarm fired */
export interface TraceEventCause {
	request?: { url?: string };
	scheduledTime?: number;
}

/**
 * The trace-event fields this Worker reads.
 *
 * Narrowed on purpose: a real event carries far more, and declaring only what is read keeps a
 * synthetic event in the gate lane a valid input rather than something that needs a cast.
 */
export interface TraceEvent {
	executionModel?: string;
	entrypoint?: string;
	outcome?: string;
	cpuTime?: number;
	wallTime?: number;
	exceptions?: TraceException[];
	logs?: TraceLog[];
	event?: TraceEventCause;
}

/**
 * One `{cfw: "php", ...}` payload, as CfwLogger emits it.
 *
 * The index signature is what makes a re-emitted line carry every field Drupal set, which is
 * the whole reason the marker exists; the three named ones are the only ones this file reads.
 */
export interface CfwLogLine {
	cfw?: string;
	level?: string;
	message?: string;
	[key: string]: unknown;
}

/**
 * One trace event, reduced to the fields worth keeping.
 *
 * `cpuTime` and `wallTime` are the reason this exists; everything else is what makes
 * a line actionable without a second lookup.
 */
export function reduceEvent(event: TraceEvent) {
	const url = String(event?.event?.request?.url ?? '');
	let path = '';
	let search = '';
	try {
		const parsed = new URL(url);
		path = parsed.pathname;
		search = parsed.search;
	} catch {
		// an alarm or a queue event has no request; both are legitimate
	}
	return {
		model: String(event?.executionModel ?? 'unknown'),
		entrypoint: event?.entrypoint ?? null,
		outcome: String(event?.outcome ?? 'unknown'),
		cpuTime: Number(event?.cpuTime ?? 0),
		wallTime: Number(event?.wallTime ?? 0),
		path: path || (event?.event?.scheduledTime !== undefined ? '(alarm)' : '(none)'),
		search,
		exceptions: (event?.exceptions ?? []).map(
			(e) => `${e?.name ?? 'Error'}: ${String(e?.message ?? '').slice(0, 200)}`
		),
		// the structured lines CfwLogger ships out of the isolate
		phpLogs: (event?.logs ?? []).map((l) => firstCfwLog(l)).filter((l) => l !== null)
	};
}

/**
 * Pulls a `{cfw: "php", ...}` payload out of one console line, or null.
 *
 * CfwLogger emits `console.log(JSON.stringify({cfw:"php", ...}))`, so the marker is
 * how a Drupal log line is told apart from any other logging in the isolate.
 */
function firstCfwLog(log: TraceLog): CfwLogLine | null {
	for (const part of log?.message ?? []) {
		if (typeof part !== 'string' || !part.includes('"cfw"')) continue;
		try {
			const parsed: CfwLogLine = JSON.parse(part);
			if (parsed?.cfw === 'php') return parsed;
		} catch {
			// not ours
		}
	}
	return null;
}

/** what `reduceEvent()` hands back, named so the batch reducers can refer to it */
export type ReducedEvent = ReturnType<typeof reduceEvent>;

/** one `byModel` bucket: how many invocations ran under one execution model, and what they cost */
export interface ModelSlot {
	n: number;
	cpuTotal: number;
	cpuMax: number;
	notOk: number;
}

/**
 * A compact summary of one batch: totals, the worst invocation, and anything that
 * went wrong.
 */
export function summarize(events: TraceEvent[]) {
	const reduced = events.map(reduceEvent);
	const byModel: Record<string, ModelSlot> = {};
	for (const r of reduced) {
		const slot = (byModel[r.model] ??= { n: 0, cpuTotal: 0, cpuMax: 0, notOk: 0 });
		slot.n++;
		slot.cpuTotal += r.cpuTime;
		if (r.cpuTime > slot.cpuMax) slot.cpuMax = r.cpuTime;
		if (r.outcome !== 'ok') slot.notOk++;
	}
	const worst = reduced.reduce<ReducedEvent | null>(
		(a, b) => (b.cpuTime > (a?.cpuTime ?? -1) ? b : a),
		null
	);
	return {
		events: reduced.length,
		byModel,
		worst:
			worst === null
				? null
				: { path: worst.path, model: worst.model, cpuTime: worst.cpuTime },
		exceptions: reduced.flatMap((r) => r.exceptions),
		phpLogs: reduced.flatMap((r) => r.phpLogs),
		// the free-plan ceiling, so a breach is named rather than left to be spotted
		overFreeCeiling: reduced.filter((r) => r.cpuTime > 10).length
	};
}

/** the three self-requests one canary run makes */
export type CanaryLeg = 'park' | 'resume' | 'oneshot';

/** one leg observed in a tail batch */
export interface CanaryObservation {
	id: string;
	leg: CanaryLeg;
	cpuTime: number;
	outcome: string;
}

/** the cpuTime each leg was charged; a leg that has not been observed yet is absent */
export type CanaryLegs = Partial<Record<CanaryLeg, number>>;

/**
 * The verdict on one canary run.
 *
 * Everything past `legs` is present only once both halves could be computed, which is why they
 * are optional rather than a union of three shapes: an incomplete run and a zero control both
 * answer with `ok` and `reason` alone.
 */
export interface CanaryVerdict {
	ok: boolean;
	reason: string;
	legs: { park: number; resume: number; oneshot: number };
	attribution?: boolean;
	reconciles?: boolean;
	ratio?: number;
	reconciliation?: number;
}

/**
 * Extracts canary observations from a batch.
 *
 * The canary tags its three self-requests `?canary=<id>&leg=park|resume|oneshot`, so
 * a leg is identified by the URL rather than by arrival order -- tail batches are not
 * ordered and can be split.
 */
export function canaryObservations(events: TraceEvent[]): CanaryObservation[] {
	const out: CanaryObservation[] = [];
	for (const event of events) {
		// only the Durable Object side is charged for the burn; the stateless hop is 0-2 ms
		if (String(event?.executionModel ?? '') !== 'durableObject') continue;
		const url = String(event?.event?.request?.url ?? '');
		const id = url.match(/[?&]canary=([A-Za-z0-9_-]{1,64})/);
		const leg = url.match(/[?&]leg=(park|resume|oneshot)/);
		if (!id || !leg) continue;
		out.push({
			// the two casts are the regexes' own guarantee: a group that matched is a string, and
			// the leg alternation is exactly the three names CanaryLeg lists
			id: id[1] as string,
			leg: leg[1] as CanaryLeg,
			cpuTime: Number(event?.cpuTime ?? 0),
			outcome: String(event?.outcome ?? 'unknown')
		});
	}
	return out;
}

/**
 * The verdict on one complete canary run.
 *
 * Two things have to hold for the attribution finding to still be true:
 *
 *   1. The resuming invocation is charged for the parked work. `/park` does 2 units,
 *      `/resume` does 120, so resume must dominate park by a wide margin.
 *   2. Nothing is lost or double-counted: park + resume must reconcile with the
 *      one-shot control.
 *
 * Thresholds are ratios, not milliseconds, because absolute cpuTime varies by colo
 * -- measured, a render that was 46 ms on one deploy was 75 ms on another.
 */
export function evaluateCanary(legs: CanaryLegs): CanaryVerdict {
	const park = Number(legs?.park ?? NaN);
	const resume = Number(legs?.resume ?? NaN);
	const oneshot = Number(legs?.oneshot ?? NaN);
	if (!Number.isFinite(park) || !Number.isFinite(resume) || !Number.isFinite(oneshot)) {
		return {
			ok: false,
			reason: 'incomplete: a leg was never observed',
			legs: { park, resume, oneshot }
		};
	}
	if (oneshot <= 0) {
		return {
			ok: false,
			reason: 'the control burned no CPU, so nothing can be compared',
			legs: { park, resume, oneshot }
		};
	}

	// the parked work landed on the resumer, not the parker
	const attribution = resume > park * 4;
	// and the two halves add up to the whole, within the noise the platform shows
	const total = park + resume;
	const reconciles = total >= oneshot * 0.6 && total <= oneshot * 1.6;

	return {
		ok: attribution && reconciles,
		attribution,
		reconciles,
		legs: { park, resume, oneshot },
		ratio: Number((resume / Math.max(park, 1)).toFixed(2)),
		reconciliation: Number((total / oneshot).toFixed(2)),
		reason: attribution
			? reconciles
				? 'attribution follows the resuming invocation and the totals reconcile'
				: `park+resume=${total} does not reconcile with the one-shot ${oneshot}`
			: `resume ${resume} did not dominate park ${park}: attribution may have moved to the ORIGINATING invocation, which kills slicing`
	};
}

/** one canary run mid-observation: when it was first seen, and the legs seen so far */
interface PendingCanary {
	firstSeen: number;
	legs: CanaryLegs;
}

/** one complete run's verdict, tagged with the canary id that produced it */
export type IdentifiedVerdict = CanaryVerdict & { id: string };

/** in-memory correlation, bounded; see the note in tail() about why that is enough */
const pending = new Map<string, PendingCanary>();

function record(observations: CanaryObservation[]): IdentifiedVerdict[] {
	const verdicts: IdentifiedVerdict[] = [];
	const now = Date.now();
	for (const [id, entry] of pending) {
		if (now - entry.firstSeen > CANARY_TTL_MS) pending.delete(id);
	}
	for (const o of observations) {
		const entry = pending.get(o.id) ?? { firstSeen: now, legs: {} };
		entry.legs[o.leg] = o.cpuTime;
		pending.set(o.id, entry);
		if (
			entry.legs.park !== undefined &&
			entry.legs.resume !== undefined &&
			entry.legs.oneshot !== undefined
		) {
			verdicts.push({ id: o.id, ...evaluateCanary(entry.legs) });
			pending.delete(o.id);
		}
	}
	return verdicts;
}

/** the one optional binding this Worker reads; the log line is the primary record without it */
export interface TailEnv {
	CANARY_SINK?: DurableObjectNamespace;
}

export default {
	/**
	 * Receives one batch of trace events from every producer that names this Worker
	 * in `tail_consumers`.
	 *
	 * Correlation is in memory and deliberately so: the canary fires three requests
	 * within a second, a Tail Worker isolate lives far longer than that, and a missed
	 * correlation degrades to "incomplete" on the next run rather than to a wrong
	 * verdict. Persisting it would need a binding whose only job is to hold three
	 * integers for one second.
	 */
	async tail(events: TraceEvent[], env?: TailEnv): Promise<void> {
		const summary = summarize(events);
		if (summary.events > 0) {
			console.log(JSON.stringify({ cfwTail: 'summary', ...summary }));
		}
		for (const line of summary.phpLogs) {
			// re-emitted at the top level so a Drupal error is greppable without
			// unpacking the summary
			if (line?.level === 'error') {
				console.error(JSON.stringify({ cfwTail: 'php-error', ...line }));
			}
		}
		for (const verdict of record(canaryObservations(events))) {
			const payload = JSON.stringify({ cfwTail: 'canary', ...verdict });
			if (verdict.ok) console.log(payload);
			// a failed canary is the signal that the platform moved under us
			else console.error(payload);
			if (env?.CANARY_SINK !== undefined) {
				try {
					const stub = env.CANARY_SINK.get(env.CANARY_SINK.idFromName('probe'));
					await stub.fetch('https://do.local/verdict', {
						method: 'POST',
						body: payload
					});
				} catch {
					// the log line is the primary record; the sink is a convenience
				}
			}
		}
	}
};
