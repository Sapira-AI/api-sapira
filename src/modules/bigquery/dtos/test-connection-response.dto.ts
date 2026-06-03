import { ApiProperty } from '@nestjs/swagger';

export class TestConnectionResponseDto {
	@ApiProperty({ description: 'Indica si la conexión fue exitosa' })
	success: boolean;

	@ApiProperty({ description: 'Mensaje descriptivo del resultado' })
	message: string;

	@ApiProperty({ description: 'ID del proyecto conectado', required: false })
	project_id?: string;

	@ApiProperty({ description: 'Número de datasets disponibles', required: false })
	datasets_count?: number;

	@ApiProperty({ description: 'Mensaje de error si la conexión falló', required: false })
	error?: string;
}
