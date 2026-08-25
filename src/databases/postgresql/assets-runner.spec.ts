import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assertTargetAllowed, checksumSql, discoverSqlAssets, runSqlAssets, SqlExecutor } from './assets-runner';

class InMemoryExecutor implements SqlExecutor {
	readonly queries: string[] = [];
	private readonly history = new Map<string, string>();

	async query(query: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
		this.queries.push(query);
		if (query.includes('SELECT asset_path, checksum')) {
			const checksum = this.history.get(values?.[0] as string);
			return { rows: checksum ? [{ asset_path: values?.[0], checksum }] : [] };
		}
		if (query.includes('INSERT INTO public.sapira_sql_asset_history')) {
			this.history.set(values?.[0] as string, values?.[1] as string);
		}
		return { rows: [] };
	}
}

describe('PostgreSQL SQL assets runner', () => {
	let assetsRoot: string;

	beforeEach(() => {
		assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sapira-assets-'));
		for (const directory of ['functions', 'special-index', 'triggers', 'rls']) {
			fs.mkdirSync(path.join(assetsRoot, directory), { recursive: true });
		}
		fs.writeFileSync(path.join(assetsRoot, 'functions', 'a.sql'), 'SELECT 1;\n');
		fs.writeFileSync(path.join(assetsRoot, 'functions', 'z.sql'), 'SELECT 2;\n');
		fs.writeFileSync(path.join(assetsRoot, 'special-index', 'index.sql'), 'CREATE INDEX IF NOT EXISTS sample_index ON sample (id);\n');
		fs.writeFileSync(path.join(assetsRoot, 'triggers', 'trigger.sql'), 'SELECT 3;\n');
		fs.writeFileSync(path.join(assetsRoot, 'rls', 'policy.sql'), 'SELECT 4;\n');
		fs.writeFileSync(
			path.join(assetsRoot, 'assets.manifest.json'),
			JSON.stringify({ version: 1, directories: ['functions', 'special-index', 'triggers', 'rls'], order: ['functions/z.sql'] })
		);
	});

	afterEach(() => fs.rmSync(assetsRoot, { recursive: true, force: true }));

	it('uses manifest priority then deterministic directory ordering', () => {
		expect(discoverSqlAssets(assetsRoot).map((asset) => asset.path)).toEqual([
			'functions/z.sql',
			'functions/a.sql',
			'special-index/index.sql',
			'triggers/trigger.sql',
			'rls/policy.sql',
		]);
	});

	it('generates stable SHA-256 checksums', () => {
		expect(checksumSql('SELECT 1;\n')).toBe('b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd');
		expect(checksumSql('SELECT 1;\n')).toBe(checksumSql('SELECT 1;\n'));
	});

	it('records applied assets and skips them idempotently', async () => {
		const executor = new InMemoryExecutor();
		const options = { assetsRoot, mode: 'apply' as const, target: 'development' };

		const firstRun = await runSqlAssets(executor, options);
		const secondRun = await runSqlAssets(executor, options);

		expect(firstRun.applied).toHaveLength(5);
		expect(secondRun.skipped).toEqual(firstRun.applied);
		expect(executor.queries.filter((query) => query === 'SELECT 1;\n')).toHaveLength(1);
	});

	it('requires explicit production confirmation before applying', () => {
		expect(() => assertTargetAllowed({ mode: 'apply', target: 'production' })).toThrow(/allow-production/);
		expect(() => assertTargetAllowed({ mode: 'apply', target: 'production', allowProduction: true, confirmTarget: 'production' })).not.toThrow();
		expect(() => assertTargetAllowed({ mode: 'dry-run', target: 'production' })).not.toThrow();
	});
});
