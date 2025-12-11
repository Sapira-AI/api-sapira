import { registerAs } from '@nestjs/config';
import { DocumentBuilder } from '@nestjs/swagger';

export const swaggerConfig = new DocumentBuilder()
	.setTitle('API SapiraAI 1.0')
	.setDescription('API Rest para SapiraAI')
	.setVersion('1.0.0')
	.setContact('Lenosoft', 'https://lenosoft.cl', 'leonmontero@lenosoft.cl')
	.addBearerAuth()
	.build();

export default registerAs('site', () => ({
	swagger: swaggerConfig,
}));
