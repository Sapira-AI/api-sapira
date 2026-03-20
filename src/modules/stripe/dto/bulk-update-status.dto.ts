import { IsArray, IsEnum, IsUUID } from 'class-validator';

import { ProcessingStatus } from './update-processing-status.dto';

export class BulkUpdateStatusDto {
	@IsArray()
	@IsUUID('4', { each: true })
	ids: string[];

	@IsEnum(ProcessingStatus)
	processing_status: ProcessingStatus;
}
