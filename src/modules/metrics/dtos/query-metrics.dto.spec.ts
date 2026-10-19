import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { MAX_DIMENSION_TOP, MrrDimensionDto, RevenueDimensionDto } from './query-metrics.dto';

const errorsOf = <T extends object>(dto: new () => T, top: string) =>
	validateSync(plainToInstance(dto, { from: '2026-01', to: '2026-03', dimension: 'client', top }) as object, {
		whitelist: true,
		forbidNonWhitelisted: true,
	});

describe('top de las matrices por dimensión (export completo del front, Domi 19-10)', () => {
	it('MRR por dimensión acepta top hasta 1000 y rechaza más', () => {
		expect(MAX_DIMENSION_TOP).toBe(1000);
		expect(errorsOf(MrrDimensionDto, '1000')).toEqual([]);
		expect(errorsOf(MrrDimensionDto, '1001')).toHaveLength(1);
		expect(errorsOf(MrrDimensionDto, '0')).toHaveLength(1);
	});

	it('Revenue por dimensión acepta top hasta 1000 y rechaza más', () => {
		expect(errorsOf(RevenueDimensionDto, '1000')).toEqual([]);
		expect(errorsOf(RevenueDimensionDto, '1001')).toHaveLength(1);
	});
});
