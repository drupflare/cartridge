import { DurableObject } from 'cloudflare:workers';

/**
 * The smallest Durable Object that satisfies `runInDurableObject`.
 *
 * The suite reaches through the instance for `ctx.storage.sql` and drives the ledger against
 * it, so the class needs SQLite-backed storage and nothing else. Adding behaviour here would
 * make the harness part of the subject.
 */
export class TestHost extends DurableObject {}

export default {
	fetch(): Response {
		// the harness is bound as a Durable Object namespace; nothing routes to the entrypoint
		return new Response('cartridge test harness', { status: 404 });
	}
};
