import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ApproveRunDto {
	@ApiProperty({
		description: 'ID del holding',
		example: 'uuid',
	})
	@IsUUID()
	holding_id!: string;
}
