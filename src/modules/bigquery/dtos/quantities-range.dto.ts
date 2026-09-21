import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, Matches } from 'class-validator';

/**
 * Formato de fecha aceptado: `YYYY-MM-DD` estricto.
 *
 * Se usa `@Matches` y no `@IsDateString()` a propósito: este último acepta cualquier ISO 8601
 * (`2026-07-01T10:30:00Z` incluido), y el resto del canal asume fecha simple — la comparación
 * `from > to` es lexicográfica y el valor viaja crudo como parámetro DATE a BigQuery.
 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_MESSAGE = 'debe tener formato YYYY-MM-DD (por ejemplo 2026-07-01), sin hora ni zona horaria';

/**
 * Ventana de fechas sobre `billing_date` del DWH, inclusiva en ambos extremos.
 *
 * Omitir ambos campos procesa el mes en curso, que es lo que hace el scheduler diario.
 * Enviar solo uno es un error: acotar por un extremo abriría la puerta a un backfill
 * accidental de todo el histórico.
 */
export class QuantitiesRangeDto {
	@ApiPropertyOptional({
		description:
			'Fecha inicial **inclusiva** sobre `billing_date`, en formato `YYYY-MM-DD`. ' +
			'Si se omite junto con `to`, se procesa el mes en curso (zona America/Santiago).',
		example: '2026-07-01',
		format: 'date',
		pattern: '^\\d{4}-\\d{2}-\\d{2}$',
	})
	@IsOptional()
	@Matches(ISO_DATE_PATTERN, { message: `from ${ISO_DATE_MESSAGE}` })
	from?: string;

	@ApiPropertyOptional({
		description:
			'Fecha final **inclusiva** sobre `billing_date`, en formato `YYYY-MM-DD`. ' +
			'Debe enviarse junto con `from` y no puede ser anterior a él.',
		example: '2026-07-31',
		format: 'date',
		pattern: '^\\d{4}-\\d{2}-\\d{2}$',
	})
	@IsOptional()
	@Matches(ISO_DATE_PATTERN, { message: `to ${ISO_DATE_MESSAGE}` })
	to?: string;
}

export class IntegrateQuantitiesDto extends QuantitiesRangeDto {
	@ApiPropertyOptional({
		description:
			'Además de las filas `pending`, reprocesa los estados recuperables (`unmapped`, `not_variable`, ' +
			'`currency_mismatch`, `blocked`). Es el camino para recuperar filas tras poblar `quote_item_number` ' +
			'o anular una factura bloqueante.',
		example: false,
		default: false,
	})
	@IsOptional()
	@IsBoolean()
	retryFailed?: boolean;
}

/** Ejemplos que Swagger UI ofrece precargados en el body de ingest y sync. */
export const QUANTITIES_RANGE_EXAMPLES = {
	mesEnCurso: {
		summary: 'Mes en curso (default)',
		description: 'Sin rango: procesa el mes calendario en curso en zona America/Santiago. Es lo que ejecuta el scheduler diario.',
		value: {},
	},
	unMes: {
		summary: 'Backfill de un mes cerrado',
		description: 'Rango inclusivo en ambos extremos.',
		value: { from: '2026-07-01', to: '2026-07-31' },
	},
	variosMeses: {
		summary: 'Backfill de un trimestre',
		description: 'No hay tope de rango: ojo con el volumen escaneado en BigQuery.',
		value: { from: '2026-01-01', to: '2026-03-31' },
	},
} as const;

/** Ejemplos del body de integrate, que además acepta `retryFailed`. */
export const INTEGRATE_QUANTITIES_EXAMPLES = {
	mesEnCurso: QUANTITIES_RANGE_EXAMPLES.mesEnCurso,
	unMes: QUANTITIES_RANGE_EXAMPLES.unMes,
	reproceso: {
		summary: 'Reprocesar lo que quedó recuperable',
		description:
			'Reintenta además los estados `unmapped`, `blocked`, `not_variable` y `currency_mismatch`. ' +
			'No consulta BigQuery, así que no tiene costo de escaneo.',
		value: { from: '2026-07-01', to: '2026-07-31', retryFailed: true },
	},
} as const;
