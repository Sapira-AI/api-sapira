import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ResolveOdooPartnerByTaxIdDto {
	@ApiProperty({ description: 'RUT, VAT o identificador fiscal a resolver', example: '76.517.784-7' })
	@IsString()
	taxId: string;

	@ApiPropertyOptional({
		description: 'Razón social requerida para desambiguar VATs genéricos de exportación',
		example: 'Empresa Exportadora SpA',
	})
	@IsOptional()
	@IsString()
	legalName?: string;
}

export class OdooPartnerCandidateDto {
	@ApiProperty({ description: 'ID del partner en Odoo' })
	id: number;

	@ApiProperty({ description: 'Nombre o razón social del partner' })
	name: string;

	@ApiProperty({ description: 'VAT del partner en Odoo' })
	vat: string;
}

export class OdooPartnerDataDto {
	@ApiPropertyOptional({ description: 'Razón social informada por Odoo', nullable: true })
	legal_name: string | null;

	@ApiPropertyOptional({ description: 'Dirección legal informada por Odoo', nullable: true })
	legal_address: string | null;

	@ApiPropertyOptional({ description: 'Email informado por Odoo', nullable: true })
	email: string | null;

	@ApiPropertyOptional({ description: 'Teléfono informado por Odoo', nullable: true })
	phone: string | null;
}

export class ResolveOdooPartnerByTaxIdResponseDto {
	@ApiProperty({
		enum: ['already_linked', 'found', 'not_found', 'ambiguous', 'missing_legal_name'],
		description: 'Resultado de la resolución',
	})
	status: 'already_linked' | 'found' | 'not_found' | 'ambiguous' | 'missing_legal_name';

	@ApiProperty({ description: 'Tax ID normalizado' })
	taxId: string;

	@ApiPropertyOptional({ description: 'ID de la entidad legal Sapira resuelta' })
	clientEntityId?: string;

	@ApiPropertyOptional({ description: 'Partner de Odoo vinculado o encontrado' })
	odooPartnerId?: number;

	@ApiPropertyOptional({ type: [OdooPartnerCandidateDto], description: 'Candidatos cuando el resultado es ambiguo' })
	candidates?: OdooPartnerCandidateDto[];

	@ApiPropertyOptional({ type: OdooPartnerDataDto, description: 'Datos del partner para confirmar antes de actualizar la entidad legal' })
	partnerData?: OdooPartnerDataDto;

	@ApiProperty({ description: 'Detalle del resultado' })
	message: string;
}
