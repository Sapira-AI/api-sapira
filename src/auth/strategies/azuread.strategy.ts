import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { PassportStrategy } from '@nestjs/passport';
import { BearerStrategy } from 'passport-azure-ad';

@Injectable()
export class AzureADStrategy extends PassportStrategy(BearerStrategy, 'azure-ad') {
	private readonly logger = new Logger(AzureADStrategy.name);

	/**
	 * Obtiene una configuración requerida o lanza un error si no está definida
	 * @param key Clave de la configuración
	 * @param description Descripción para el mensaje de error
	 * @returns El valor de la configuración
	 */
	private getRequiredConfig(key: string, description: string): string {
		const value = this.configService.get<string>(key);
		if (!value) {
			throw new Error(`Variable de entorno ${key} no definida. Esta variable es necesaria para ${description}.`);
		}
		return value;
	}

	constructor(
		private reflector: Reflector,
		private configService: ConfigService
	) {
		// Primero obtenemos las configuraciones directamente del configService sin usar this
		const getRequiredConfig = (key: string, description: string): string => {
			const value = configService.get<string>(key);
			if (!value) {
				throw new Error(`Variable de entorno ${key} no definida. Esta variable es necesaria para ${description}.`);
			}
			return value;
		};

		// Configuración de Azure AD
		const tenantID = getRequiredConfig('AZURE_TENANT_ID', 'ID del inquilino de Azure');
		const clientID = getRequiredConfig('AZURE_CLIENT_ID', 'ID del cliente de Azure');
		const audience = getRequiredConfig('AZURE_AUDIENCE', 'Audiencia de Azure');
		const authority = getRequiredConfig('AZURE_AUTHORITY', 'Autoridad de Azure');
		const policyName = getRequiredConfig('AZURE_POLICY_NAME', 'Nombre de la política de Azure');
		const discovery = getRequiredConfig('AZURE_DISCOVERY', 'Ruta de descubrimiento de Azure');
		const version = getRequiredConfig('AZURE_VERSION', 'Versión de la API de Azure');
		const validateIssuer = configService.get<string>('AZURE_VALIDATE_ISSUER') === 'true' || false;
		const loggingLevel = configService.get<string>('AZURE_LOGGING_LEVEL') || 'error';
		const exposedScopes = configService.get<string>('AZURE_EXPOSED_SCOPES')
			? configService.get<string>('AZURE_EXPOSED_SCOPES').split(',')
			: ['User.Read'];

		// Crear el objeto de configuración
		const config = {
			identityMetadata: `https://${authority}/${tenantID}.onmicrosoft.com/${policyName}/${version}/${discovery}`,
			clientID: clientID,
			validateIssuer: validateIssuer,
			issuer: null,
			passReqToCallback: true,
			isB2C: true,
			policyName: policyName,
			allowMultiAudiencesInToken: false,
			audience: audience,
			loggingLevel: loggingLevel,
			loggingNoPII: false,
			scope: exposedScopes,
		};

		super(config);
	}

	async validate(req: any, profile: any): Promise<any> {
		const startTime = process.hrtime();

		try {
			// Log to console instead of Application Insights
			this.logger.log('Token Validation Start:', {
				userId: profile.oid,
				policyName: this.configService.get<string>('AZURE_POLICY_NAME'),
				timestamp: new Date().toISOString(),
			});

			const user = profile;

			const [seconds, nanoseconds] = process.hrtime(startTime);
			const duration = seconds * 1000 + nanoseconds / 1000000;

			if (req && req.headers) {
				req.headers['x-dependency-duration'] = duration.toString();
			}

			// Log metrics to console
			this.logger.log('Token Validation Duration:', {
				name: 'TokenValidationDuration',
				value: duration,
				properties: {
					userId: profile.oid,
					success: true,
				},
			});

			this.logger.log('Token Validation Success:', {
				userId: profile.oid,
				duration: duration.toString(),
				timestamp: new Date().toISOString(),
			});

			return user;
		} catch (error) {
			const [seconds, nanoseconds] = process.hrtime(startTime);
			const duration = seconds * 1000 + nanoseconds / 1000000;

			// Log exception to console
			this.logger.error('Token Validation Exception:', {
				exception: {
					name: error.name,
					message: error.message,
					stack: error.stack,
				},
				properties: {
					operation: 'TokenValidation',
					userId: profile?.oid,
					duration: duration.toString(),
					errorMessage: error.message,
				},
			});

			throw error;
		}
	}
}
