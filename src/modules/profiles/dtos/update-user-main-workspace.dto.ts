import { ApiProperty } from '@nestjs/swagger';
import { IsDefined } from 'class-validator';

export class UpdateUserMainWorkspaceDTO {
	@ApiProperty({ required: true })
	@IsDefined()
	mainWorkspace: string;
}
