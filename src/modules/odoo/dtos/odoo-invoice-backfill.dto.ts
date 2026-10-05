import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Grupos de campos que el backfill puede escribir.
 *
 * `folio` y `estado` son seguros. **`montos` y `fecha` obligan a reconstruir el cronograma de
 * revenue a mano**: `trg_rsm_on_invoice_change` dispara con `total_invoice_currency` e `issue_date`,
 * pero su función sale en seco con la conexión de la API (rol `postgres` sin claims JWT, así que
 * `rls_user_holding_id()` devuelve NULL), y `revenue_schedule_monthly` quedaría con los números
 * viejos. Detalle en `docs/cambios/backfill-folios-odoo.md`.
 */
export type CampoBackfill = 'folio' | 'estado' | 'montos' | 'fecha';

export const CAMPOS_BACKFILL: CampoBackfill[] = ['folio', 'estado', 'montos', 'fecha'];

/** Lo seguro: recuperar lo que se perdió, sin mover ninguna cifra ni ninguna fecha. */
export const CAMPOS_BACKFILL_POR_DEFECTO: CampoBackfill[] = ['folio', 'estado'];

/** Por qué una candidata quedó fuera. Son las tres guardas del backfill, más el id inexistente. */
export type MotivoOmisionBackfill =
	| 'no_existe_en_odoo'
	| 'sin_x_sapira_invoice_id_en_odoo'
	| 'x_sapira_invoice_id_no_coincide'
	| 'no_publicada_en_odoo'
	| 'sin_folio_en_odoo';

export class BackfillCambioDto {
	@ApiProperty({ description: 'Columna de `invoices` que cambia', example: 'invoice_number' })
	campo: string;

	@ApiPropertyOptional({ description: 'Valor actual en Sapira; ausente si estaba en null', example: null })
	antes?: string;

	@ApiProperty({ description: 'Valor que trae Odoo', example: 'F101-00004388' })
	despues: string;
}

export class BackfillFacturaDto {
	@ApiProperty({ description: 'ID de la factura en Sapira', example: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6' })
	id: string;

	@ApiProperty({ description: 'ID de la factura en Odoo', example: 199014 })
	odoo_invoice_id: number;

	@ApiProperty({ description: 'Campos que cambian, con su valor antes y después', type: [BackfillCambioDto] })
	cambios: BackfillCambioDto[];

	@ApiProperty({ description: 'Si se escribió en la base. En seco siempre es false.', example: false })
	aplicado: boolean;
}

export class BackfillOmitidaDto {
	@ApiProperty({ description: 'ID de la factura en Sapira', example: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6' })
	id: string;

	@ApiProperty({ description: 'ID de la factura en Odoo', example: 199014 })
	odoo_invoice_id: number;

	@ApiProperty({
		description:
			'`no_existe_en_odoo`: Odoo no conoce ese id. `sin_x_sapira_invoice_id_en_odoo` / ' +
			'`x_sapira_invoice_id_no_coincide`: el amarre entre los dos sistemas falta o apunta a otra factura — **esto se revisa a ' +
			'mano, es la guarda que evita escribir el folio en la factura equivocada**. `no_publicada_en_odoo`: sigue en borrador. ' +
			'`sin_folio_en_odoo`: publicada pero Odoo no le asignó `name`.',
		enum: [
			'no_existe_en_odoo',
			'sin_x_sapira_invoice_id_en_odoo',
			'x_sapira_invoice_id_no_coincide',
			'no_publicada_en_odoo',
			'sin_folio_en_odoo',
		],
		example: 'no_publicada_en_odoo',
	})
	motivo: MotivoOmisionBackfill;
}

export class BackfillResultadoDto {
	@ApiProperty({ description: 'Cuándo se corrió', example: '2026-10-01T18:40:12.000Z' })
	generado_en: Date;

	@ApiProperty({ description: 'Holding sobre el que se corrió', example: '123e4567-e89b-12d3-a456-426614174000' })
	holding_id: string;

	@ApiProperty({ description: 'false = corrida en seco, no se escribió nada', example: false })
	aplicado: boolean;

	@ApiProperty({
		description: 'Grupos de campos que se sincronizaron en esta corrida',
		enum: CAMPOS_BACKFILL,
		isArray: true,
		example: ['folio', 'estado'],
	})
	campos: CampoBackfill[];

	@ApiProperty({ description: 'Facturas enviadas a Odoo y sin folio que entraron a la corrida', example: 154 })
	candidatas: number;

	@ApiProperty({ description: 'Cuántas de esas devolvió Odoo', example: 154 })
	leidas_de_odoo: number;

	@ApiProperty({ description: 'Cuántas tienen al menos un campo distinto', example: 154 })
	con_cambios: number;

	@ApiProperty({ description: 'Cuántas se escribieron. En seco siempre 0.', example: 0 })
	actualizadas: number;

	@ApiProperty({ description: 'Cuántas ya estaban iguales a Odoo', example: 0 })
	sin_cambios: number;

	@ApiProperty({ description: 'Candidatas que no se tocaron, con el motivo', type: [BackfillOmitidaDto] })
	omitidas: BackfillOmitidaDto[];

	@ApiProperty({ description: 'Detalle por factura de lo que cambia', type: [BackfillFacturaDto] })
	facturas: BackfillFacturaDto[];

	@ApiProperty({
		description: 'Si se alcanzó el tope de 1000 por corrida: quedan más y hay que volver a correrlo',
		example: false,
	})
	tope_alcanzado: boolean;
}

export class EjecutarBackfillDto {
	@ApiPropertyOptional({ description: 'Ventana en días sobre `sent_to_odoo_at`. Sin esto, toda la historia.', example: 30 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(365)
	dias?: number;

	@ApiPropertyOptional({
		description: 'Si es `true` escribe en la base. Omitirlo o mandarlo en `false` es una corrida en seco.',
		example: false,
		default: false,
	})
	@IsOptional()
	@IsBoolean()
	aplicar?: boolean;

	@ApiPropertyOptional({
		description: 'Acota a estos ids de Odoo, para recuperar casos puntuales sin barrer el mes.',
		example: [199014, 199077],
		type: [Number],
	})
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(1000)
	@Type(() => Number)
	@IsInt({ each: true })
	odoo_invoice_ids?: number[];

	@ApiPropertyOptional({
		description:
			'Qué escribir. El default, `["folio","estado"]`, es el único alcance seguro de correr solo: agregar `montos` o `fecha` ' +
			'obliga a reconstruir después `revenue_schedule_monthly` a mano, porque el trigger de RSM no se dispara con la conexión ' +
			'de la API.',
		enum: CAMPOS_BACKFILL,
		isArray: true,
		default: CAMPOS_BACKFILL_POR_DEFECTO,
		example: ['folio', 'estado'],
	})
	@IsOptional()
	@IsArray()
	@ArrayNotEmpty()
	@IsIn(CAMPOS_BACKFILL, { each: true })
	campos?: CampoBackfill[];

	@ApiPropertyOptional({
		description:
			'Acota a las facturas que hoy están en estos estados en Sapira. Sirve para separar poblaciones: `["Emitida"]` son las ' +
			'que el scheduler sí emitió y solo les falta el folio; `["Por Emitir"]` nunca se emitieron en Sapira y pasarlas a ' +
			'`Enviada` **sí** cambia revenue.',
		example: ['Emitida'],
		type: [String],
	})
	@IsOptional()
	@IsArray()
	@ArrayNotEmpty()
	@IsString({ each: true })
	estados?: string[];
}
