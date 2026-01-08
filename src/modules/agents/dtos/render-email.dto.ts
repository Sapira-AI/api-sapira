import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsObject, IsString } from 'class-validator';

export class RenderEmailDto {
	@ApiProperty({
		description: 'Tipo de agente',
		enum: ['proforma', 'collections'],
		example: 'proforma',
	})
	@IsEnum(['proforma', 'collections'])
	agent_type!: 'proforma' | 'collections';

	@ApiProperty({
		description: 'Plantilla de email',
		example: 'Estimado {{contact_name}}, ...',
	})
	@IsString()
	template!: string;

	@ApiProperty({
		description: 'Variables para reemplazar en la plantilla',
		example: {
			client_name: 'Empresa ABC',
			contact_name: 'Juan Pérez',
			invoice_number: 'F-001',
		},
	})
	@IsObject()
	variables!: Record<string, any>;
}
