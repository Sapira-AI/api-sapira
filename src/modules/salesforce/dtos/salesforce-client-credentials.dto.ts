import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

export class SalesforceClientCredentialsDto {
	@ApiProperty({
		description: 'Client ID de la Connected App',
		example: '3MVG9nSH73I5aFNg_NOm3V2_QPgOZgilu96B50Ia25vC.NwfGYL9G5yDFh_VM5Ps.DSyMYnqBcoZDbQs9NA',
	})
	@IsNotEmpty()
	@IsString()
	clientId: string;

	@ApiProperty({
		description: 'Client Secret de la Connected App',
		example: 'C8162F7068EDE3CA9146B041DB457CECDEA1C8C077CDAB89A46BD8F0C18C0E',
	})
	@IsNotEmpty()
	@IsString()
	clientSecret: string;

	@ApiProperty({
		description: 'URL de login de Salesforce',
		example: 'https://login.salesforce.com',
		required: false,
	})
	@IsOptional()
	@IsUrl()
	loginUrl?: string;
}
