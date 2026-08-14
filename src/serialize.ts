/**
 * Serializes every PHP invocation against one interpreter.
 */

/** what `stats()` reports; `maxConcurrent` above 1 is a serialization failure by definition */
export interface GateStats {
	maxConcurrent: number;
	active: number;
	queued: number;
	completed: number;
	order: string[];
}

/** the subset of a Durable Object state that `doGate()` can use, if present */
export interface BlockingContext {
	blockConcurrencyWhile?: <T>(fn: () => Promise<T> | T) => Promise<T>;
}

/** the gate-shaped surface `doGate()` returns */
export interface GateLike {
	run<T>(fn: () => Promise<T> | T, label?: string): Promise<T>;
	stats(): GateStats;
	drain(): Promise<void>;
}

/**
 * FIFO gate. Every `run()` waits for the previous one to settle, so at most one callback is
 * ever in flight.
 */
export class Gate {
	/** tail of the promise chain; each run() links onto it */
	private _tail: Promise<unknown> = Promise.resolve();
	private _active = 0;
	private _queued = 0;
	/**
	 * Peak simultaneous callbacks observed. Any value above 1 is a serialization failure, so the
	 * tests assert on this rather than on timing.
	 */
	private _maxConcurrent = 0;
	private _completed = 0;
	private _order: string[] = [];

	/**
	 * Runs `fn` once every previously-submitted task has settled.
	 *
	 * A rejecting `fn` must not wedge the chain, so the link is released in a `finally` and the
	 * rejection is re-thrown to the caller only.
	 */
	run<T>(fn: () => Promise<T> | T, label?: string): Promise<T> {
		const previous = this._tail;
		let release!: () => void;
		this._tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		this._queued++;

		return (async () => {
			// swallow the predecessor's rejection: it belongs to its own caller, and propagating
			// it here would fail an unrelated request
			try {
				await previous;
			} catch {
				/* predecessor's problem */
			}

			this._queued--;
			this._active++;
			if (this._active > this._maxConcurrent) this._maxConcurrent = this._active;
			try {
				return await fn();
			} finally {
				this._active--;
				this._completed++;
				if (label !== undefined) this._order.push(label);
				release();
			}
		})();
	}

	stats(): GateStats {
		return {
			maxConcurrent: this._maxConcurrent,
			active: this._active,
			queued: this._queued,
			completed: this._completed,
			order: this._order.slice()
		};
	}

	/** resolves once everything submitted so far has settled */
	async drain(): Promise<void> {
		await this._tail.catch(() => {});
	}
}

/**
 * Durable Object flavour: serializes with the gate AND asks the runtime to stop delivering
 * events for the duration.
 *
 * `blockConcurrencyWhile` cannot be nested, so the gate is entered first and the block is taken
 * inside it -- never the other way round.
 */
export function doGate(gate: Gate, ctx: BlockingContext): GateLike {
	return {
		run<T>(fn: () => Promise<T> | T, label?: string): Promise<T> {
			return gate.run<T>(
				() =>
					typeof ctx?.blockConcurrencyWhile === 'function'
						? ctx.blockConcurrencyWhile(async () => fn())
						: fn(),
				label
			);
		},
		stats: () => gate.stats(),
		drain: () => gate.drain()
	};
}
