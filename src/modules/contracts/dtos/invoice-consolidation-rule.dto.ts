import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, Equals, IsArray, IsBoolean, IsUUID } from 'class-validator';

import { CONSOLIDATION_RULE_MIN_CONTRACTS } from '../invoice-consolidation-rules';

/** `POST client-entities/:id/invoice-consolidation/preview` (`spec-unificacion-recurrente.md` §3). */
export class InvoiceConsolidationRulePreviewDto {
	@ApiProperty({ type: [String], description: `Contratos activos de la razón social que se unifican (${CONSOLIDATION_RULE_MIN_CONTRACTS} o más)` })
	@IsArray({ message: 'contract_ids debe ser una lista' })
	@ArrayMinSize(CONSOLIDATION_RULE_MIN_CONTRACTS, { message: 'Elige al menos 2 contratos' })
	@ArrayUnique({ message: 'Hay contratos repetidos' })
	@IsUUID(undefined, { each: true, message: 'Contrato inválido' })
	contract_ids!: string[];

	@ApiProperty({ description: 'Contrato principal (encabezado y fecha de emisión de la unificada); debe estar en contract_ids' })
	@IsUUID(undefined, { message: 'Contrato principal inválido' })
	main_contract_id!: string;
}

/** `PUT client-entities/:id/invoice-consolidation`: guarda la regla y unifica ya. */
export class InvoiceConsolidationRuleDto extends InvoiceConsolidationRulePreviewDto {
	@ApiProperty({ description: 'La usuaria confirma que la unificada se emite en la fecha del contrato principal (D1 de Domi 05-10)' })
	@IsBoolean({ message: 'Confirma la fecha de emisión' })
	@Equals(true, { message: 'Confirma la fecha de emisión de la factura unificada' })
	confirm_issue_date!: boolean;
}

/** `POST client-entities/:id/invoice-consolidation/pause`. */
export class InvoiceConsolidationRulePauseDto {
	@ApiProperty({ description: 'Deshacer las unificadas de la regla que siguen Por Emitir y sin borrador en el ERP' })
	@IsBoolean({ message: 'undo_pending debe ser verdadero o falso' })
	undo_pending!: boolean;
}
