import { BadRequestException, Logger, ValidationError, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { swaggerConfig } from './core/config/site.config';
import { GlobalExceptionFilter } from './core/filters/global-exception.filter';
import { AppLoggerService } from './logger/app-logger.service';
import { TelemetryService } from './telemetry/telemetry.service';

process.env.TZ = 'America/Santiago';

async function bootstrap() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule);

	// Obtener servicios necesarios para el filtro de excepciones
	const logger = app.get(AppLoggerService);
	const telemetry = app.get(TelemetryService);

	// Configurar el filtro global de excepciones usando useGlobalFilters
	app.useGlobalFilters(new GlobalExceptionFilter(logger, telemetry));

	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true,
			disableErrorMessages: false,
			errorHttpStatusCode: 400,
			exceptionFactory: (errors: ValidationError[]) => {
				const messages = errors.map((error) => {
					if (error.constraints) {
						return Object.values(error.constraints)[0];
					}
					return 'Error de validación';
				});
				const message = messages.join(', ');
				throw new BadRequestException(message);
			},
		})
	);

	const nestLogger = new Logger('NestApplication');

	app.disable('x-powered-by');

	// Habilitar el procesamiento de cookies
	app.use((cookieParser as unknown as () => any)());

	// Aplicar headers de seguridad con Helmet
	app.use(
		helmet({
			contentSecurityPolicy: {
				directives: {
					defaultSrc: ["'self'"],
					// Para APIs REST puras, podemos ser más estrictos
					// Si Swagger da problemas, agregar 'unsafe-inline' solo en desarrollo
					scriptSrc: process.env.NODE_ENV === 'production' ? ["'self'"] : ["'self'", "'unsafe-inline'"],
					styleSrc: process.env.NODE_ENV === 'production' ? ["'self'"] : ["'self'", "'unsafe-inline'"],
					imgSrc: ["'self'", 'data:', 'https:'],
					connectSrc: ["'self'", 'https://*.b2clogin.com'],
					frameSrc: ["'self'", 'https://*.b2clogin.com'],
					fontSrc: ["'self'", 'https:', 'data:'],
					objectSrc: ["'none'"],
					baseUri: ["'self'"],
					formAction: ["'self'"],
					frameAncestors: ["'self'"],
					upgradeInsecureRequests: [],
				},
			},
			crossOriginEmbedderPolicy: false,
			crossOriginOpenerPolicy: false,
			crossOriginResourcePolicy: { policy: 'cross-origin' },
			hsts: {
				maxAge: 31536000, // 1 año
				includeSubDomains: true,
				preload: true,
			},
			frameguard: {
				action: 'sameorigin',
			},
			noSniff: true,
			xssFilter: true,
			hidePoweredBy: true,
			referrerPolicy: {
				policy: 'strict-origin-when-cross-origin',
			},
			permittedCrossDomainPolicies: {
				permittedPolicies: 'none',
			},
		})
	);

	// Agregar Permissions-Policy manualmente (Helmet no lo incluye por defecto)
	app.use((req, res, next) => {
		res.setHeader(
			'Permissions-Policy',
			'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
		);
		next();
	});

	// Configuración específica de CORS
	app.enableCors({
		origin: [/\.vercel\.app$/, process.env.FRONT_BASE_URL],
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
		allowedHeaders: [
			'Origin',
			'X-Requested-With',
			'Content-Type',
			'Accept',
			'Authorization',
			'X-Workspace-Id',
			'X-Holding-Id',
			'x-api-key',
			'x-device-info',
			'x-device-id',
			'User-Agent',
			'x-app-version',
		],
		exposedHeaders: ['Authorization', 'x-device-id', 'x-device-info', 'x-app-version'],
		credentials: true,
		preflightContinue: false,
		optionsSuccessStatus: 204,
	});

	// Aumentar el límite de tamaño del cuerpo de las solicitudes
	// IMPORTANTE: No aplicar body-parser a rutas de upload (multipart/form-data)
	app.use((req, res, next) => {
		// Excluir rutas que usan multipart/form-data
		if (req.path.includes('/upload') || req.headers['content-type']?.includes('multipart/form-data')) {
			return next();
		}
		bodyParser.json({ limit: '50mb' })(req, res, next);
	});
	app.use((req, res, next) => {
		// Excluir rutas que usan multipart/form-data
		if (req.path.includes('/upload') || req.headers['content-type']?.includes('multipart/form-data')) {
			return next();
		}
		bodyParser.urlencoded({ limit: '50mb', extended: true })(req, res, next);
	});

	const document = SwaggerModule.createDocument(app, swaggerConfig);
	SwaggerModule.setup('api', app, document, {
		swaggerOptions: { defaultModelsExpandDepth: -1 },
	});

	const configService: ConfigService = app.get<ConfigService>(ConfigService);
	const port = configService.get('PORT') || 8082;

	await app.listen(port);
	nestLogger.log(`Application started and listening on ${port}`);
}

bootstrap();
