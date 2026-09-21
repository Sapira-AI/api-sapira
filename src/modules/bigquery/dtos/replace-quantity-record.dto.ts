import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

/**
 * Valores entrantes (desde el DWH, tomados de action_payload.incoming) que reemplazarán
 * al override ya existente en `quantities`.
 *
 * `amount` no se incluye a propósito: el canal automático nunca lo escribe (se llena por
 * otro lado) y los triggers hacen COALESCE(amount, unit_price * quantity), así que
 * mandarlo pisaría el cálculo.
 */
export class ReplaceQuantityRecordDto {
	@ApiPropertyOptional({ description: 'Precio unitario override. Debe ser >= 0 (constraint quantities_unit_price_check).' })
	@IsOptional()
	@IsNumber()
	@Min(0)
	unit_price?: number | null;

	@ApiPropertyOptional({ description: 'Cantidad override. Debe ser >= 0 (constraint quantities_quantity_check). Se permite 0.' })
	@IsOptional()
	@IsNumber()
	@Min(0)
	quantity?: number | null;

	@ApiPropertyOptional({ description: 'Unidad de medida (máx. 32 caracteres).' })
	@IsOptional()
	@IsString()
	unit_of_measure?: string | null;

	@ApiPropertyOptional({ description: 'Cuenta contable proveniente del DWH (texto libre).' })
	@IsOptional()
	@IsString()
	account?: string | null;
}
