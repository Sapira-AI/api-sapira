import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SalesforceQueryDto {
	@ApiProperty({
		description: 'Consulta SOQL a ejecutar',
		example: 'SELECT Id, Name, Email FROM Contact LIMIT 10',
	})
	@IsNotEmpty()
	@IsString()
	query: string;
}
