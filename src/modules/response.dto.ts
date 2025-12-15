import { ApiProperty } from '@nestjs/swagger';

export class ResponseDTO<T> {
	@ApiProperty({ required: true })
	status: number;

	@ApiProperty({ required: true })
	message: string;

	@ApiProperty({ required: true })
	data: T | T[];
}
