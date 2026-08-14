import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						remoteBindings: false,
						wrangler: { configPath: './wrangler.jsonc' },
						miniflare: {
							isolatedStorage: true
						}
					})
				],
				test: {
					name: 'unit',
					include: ['tests/*.spec.ts'],
					maxWorkers: process.env.CI ? 1 : 2,
					testTimeout: 15000
				}
			},
			{
				test: {
					name: 'interpreters',
					include: ['tests/interpreters/*.spec.ts'],
					environment: 'node',
					testTimeout: 120000,
					maxWorkers: 1
				}
			}
		],
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**'],
			exclude: ['tests/**', '**/*.d.ts']
		}
	}
});
