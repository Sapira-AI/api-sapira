import { ApiProperty } from '@nestjs/swagger';

export class BigQueryConnectionResponseDto {
	@ApiProperty({ description: 'ID de la conexión' })
	id: string;

	@ApiProperty({ description: 'ID del holding' })
	holding_id: string;

	@ApiProperty({ description: 'ID del usuario que creó la conexión' })
	user_id: string;

	@ApiProperty({ description: 'Nombre descriptivo de la conexión' })
	name: string;

	@ApiProperty({ description: 'ID del proyecto de GCP' })
	project_id: string;

	@ApiProperty({ description: 'ID del dataset (opcional)', required: false })
	dataset_id?: string;

	@ApiProperty({ description: 'Indica si la conexión está activa' })
	is_active: boolean;

	@ApiProperty({ description: 'Timestamp de la última sincronización', required: false })
	last_sync_at?: Date;

	@ApiProperty({ description: 'Fecha de creación' })
	created_at: Date;

	@ApiProperty({ description: 'Fecha de última actualización' })
	updated_at: Date;
}
