import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';

/** Máximo de contratos por acción masiva de configuración o borrado. */
export const BULK_MAX_IDS = 500;
/** Máximo de contratos por activación (cada uno genera sus facturas en su propia transacción). */
export const ACTIVATE_MAX_IDS = 100;

/** `{ ids }` de `POST /contracts/bulk-delete`. El holding sale del guard, nunca del body. */
export class BulkContractIdsDto {
	@ApiProperty({ type: [String], description: `UUID de los contratos (1 a ${BULK_MAX_IDS})` })
	@IsArray({ message: 'Elige al menos un contrato' })
	@ArrayMinSize(1, { message: 'Elige al menos un contrato' })
	@ArrayMaxSize(BULK_MAX_IDS, { message: `Máximo ${BULK_MAX_IDS} contratos por acción` })
	@IsUUID(undefined, { each: true, message: 'Contrato inválido' })
	ids!: string[];
}

/** Body de `PATCH /contracts/bulk-settings`: al menos un interruptor (automatizaciones o marcas del contrato, Domi 26-10). */
export class BulkContractSettingsDto extends BulkContractIdsDto {
	@ApiPropertyOptional({ description: 'Envío automático de las facturas al ERP' })
	@IsBoolean({ message: 'Envío automático al ERP inválido' })
	@IsOptional()
	auto_send_to_odoo?: boolean;

	@ApiPropertyOptional({ description: 'Emisión automática (requiere el envío automático al ERP, S6-10)' })
	@IsBoolean({ message: 'Emisión automática inválida' })
	@IsOptional()
	auto_invoice?: boolean;

	@ApiPropertyOptional({ description: 'Requiere OC/HES: contrato y todas sus Por Emitir vivas (también las atrasadas)' })
	@IsBoolean({ message: 'Marca Requiere OC/HES inválida' })
	@IsOptional()
	requires_references_for_billing?: boolean;

	@ApiPropertyOptional({
		description: 'Multimoneda: apagarla con ítems en otra moneda deja el contrato bloqueado en el resumen (no se rechaza la acción)',
	})
	@IsBoolean({ message: 'Marca Multimoneda inválida' })
	@IsOptional()
	requires_multicurrency_billing?: boolean;

	@ApiPropertyOptional({ description: 'Multiempresa: marca informativa' })
	@IsBoolean({ message: 'Marca Multiempresa inválida' })
	@IsOptional()
	requires_multicompany_billing?: boolean;
}

/** `{ ids }` de `POST /contracts/activate` y `POST /contracts/activate/preview`. */
export class ActivateContractsDto {
	@ApiProperty({ type: [String], description: `UUID de los contratos (1 a ${ACTIVATE_MAX_IDS})` })
	@IsArray({ message: 'Elige al menos un contrato' })
	@ArrayMinSize(1, { message: 'Elige al menos un contrato' })
	@ArrayMaxSize(ACTIVATE_MAX_IDS, { message: `Máximo ${ACTIVATE_MAX_IDS} contratos por activación` })
	@IsUUID(undefined, { each: true, message: 'Contrato inválido' })
	ids!: string[];
}
