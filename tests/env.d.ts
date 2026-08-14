/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Types for the vitest project.
 *
 * The `cloudflare:test` module types ship on a subpath the tsconfig `types` array cannot reach,
 * so the reference above brings them in instead.
 *
 * `ProvidedEnv` is what `import { env } from 'cloudflare:test'` resolves to. It is declared by
 * hand rather than generated because this repo does not run `wrangler types`, and the only
 * binding a spec needs is the harness Durable Object namespace from `wrangler.jsonc`.
 */
declare module 'cloudflare:test' {
	interface ProvidedEnv extends Cloudflare.Env {}
}

// `env` from `cloudflare:test` is typed as `Cloudflare.Env`, so the bindings are declared on
// that namespace rather than on ProvidedEnv alone
declare namespace Cloudflare {
	interface Env {
		SITE: DurableObjectNamespace;
	}
}

/**
 * Vite's `?raw` suffix, for a spec that reads a source file as text.
 *
 * `node:fs` does not exist in workerd, and `?raw` is resolved at transform time so the string
 * travels into the isolate with the code. `tests/mask.spec.ts` and `tests/lazy-fs.spec.ts` read
 * their own subjects that way, which is the case this exists for.
 */
declare module '*?raw' {
	const src: string;
	export default src;
}
