import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateBigQueryConnectionDto {
	@ApiProperty({
		description: 'Nombre descriptivo de la conexión',
		example: 'BigQuery Production',
	})
	@IsString()
	@IsNotEmpty()
	name: string;

	@ApiProperty({
		description: 'ID del proyecto de Google Cloud Platform',
		example: 'datawarehouse-a2e2',
	})
	@IsString()
	@IsNotEmpty()
	project_id: string;

	@ApiProperty({
		description: 'Credenciales JSON de la cuenta de servicio de GCP',
		example: '{"type":"service_account","project_id":"...","private_key":"..."}',
	})
	@IsString()
	@IsNotEmpty()
	credentials: string;

	@ApiProperty({
		description: 'ID del dataset específico (opcional)',
		example: 'finance',
		required: false,
	})
	@IsString()
	@IsOptional()
	dataset_id?: string;

	@ApiProperty({
		description: 'Indica si la conexión está activa',
		example: true,
		default: true,
		required: false,
	})
	@IsBoolean()
	@IsOptional()
	is_active?: boolean;
}
