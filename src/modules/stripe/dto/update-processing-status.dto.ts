import { IsEnum } from 'class-validator';

export enum ProcessingStatus {
	PENDING = 'pending',
	PROCESSED = 'processed',
	ERROR = 'error',
	TO_CREATE = 'to_create',
	TO_UPDATE = 'to_update',
}

export class UpdateProcessingStatusDto {
	@IsEnum(ProcessingStatus)
	processing_status: ProcessingStatus;
}
