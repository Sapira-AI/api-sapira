import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import * as metricsData from './metrics-data.service';
import { NOT_PENDING_RENEWAL, PENDING } from './rsm-momentum';

/** D-CTR-1 (spec revenue §6): una sola definición del "pendiente de renovar", en Métricas; Contratos la importa de aquí. */
describe('rsm-momentum (D-CTR-1)', () => {
	it('define la regla una vez y metrics-data.service la reexporta tal cual', () => {
		expect(PENDING).toBe('PENDING_RENEWAL');
		expect(NOT_PENDING_RENEWAL).toBe("r.momentum IS DISTINCT FROM 'PENDING_RENEWAL'");
		expect(metricsData.NOT_PENDING_RENEWAL).toBe(NOT_PENDING_RENEWAL);
		expect(metricsData.PENDING).toBe(PENDING);
	});

	it('ni Métricas ni Contratos repiten el literal: lo importan de rsm-momentum', () => {
		const sources = ['../metrics', '../contracts'].flatMap((dir) =>
			readdirSync(join(__dirname, dir))
				.filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts') && file !== 'rsm-momentum.ts')
				.map((file) => ({ file, text: readFileSync(join(__dirname, dir, file), 'utf8') }))
		);
		const duplicated = sources.filter(({ text }) => /IS DISTINCT FROM '(PENDING_RENEWAL|\$\{PENDING\})'/.test(text)).map(({ file }) => file);

		expect(duplicated).toEqual([]);
		expect(sources.find(({ file }) => file === 'contracts.service.ts')?.text).toContain("from '@/modules/metrics/rsm-momentum'");
		expect(sources.find(({ file }) => file === 'contracts.service.ts')?.text).not.toMatch(/export const NOT_PENDING_RENEWAL/);
	});
});
