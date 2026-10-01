import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/** Query de `GET /contracts/form-options`. */
export class QueryContractFormOptionsDto {
	@ApiPropertyOptional({
		description:
			'Razón social receptora ya elegida: con ella `companies[].suggested_tax_document_type_id` distingue factura local de exportación (país emisor vs receptor). Sin ella, se sugiere la factura local',
	})
	@IsUUID(undefined, { message: 'Razón social inválida' })
	@IsOptional()
	client_entity_id?: string;
}
