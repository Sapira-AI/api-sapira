import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import type { Row } from './settings-common';

/**
 * Catálogo global de países (ISO 3166-1 alfa-2, tabla `countries`, M7). No es de un holding: solo exige sesión (regla de tenancy:
 * los catálogos globales no usan `HoldingScopeGuard`).
 */
@ApiTags('Catálogos')
@Controller('catalog')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class CountriesController {
	constructor(private readonly dataSource: DataSource) {}

	@Get('countries')
	@ApiOperation({ summary: 'Países ISO 3166-1 alfa-2 con nombre en español e inglés' })
	async list() {
		const rows = (await this.dataSource.query(`SELECT code, name_es, name_en FROM countries ORDER BY name_es`)) as Row[];

		return rows.map((row) => ({ code: String(row.code).trim(), name_es: String(row.name_es), name_en: String(row.name_en) }));
	}
}
