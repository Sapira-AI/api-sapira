import { HttpService } from '@nestjs/axios';
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { EncryptionService } from '@/common/services/encryption.service';

import { SalesforceAuthType, SalesforceConnection } from '../entities/salesforce-connection.entity';
import { SalesforceAuthResponse } from '../interfaces/salesforce.interface';

import { SalesforceSoapService } from './salesforce-soap.service';

@Injectable()
export class SalesforceTokenService {
	private readonly logger = new Logger(SalesforceTokenService.name);

	constructor(
		@InjectRepository(SalesforceConnection)
		private readonly connectionRepository: Repository<SalesforceConnection>,
		private readonly httpService: HttpService,
		private readonly encryptionService: EncryptionService,
		@Inject(forwardRef(() => SalesforceSoapService))
		private readonly soapService: SalesforceSoapService
	) {}

	async ensureValidToken(connection: SalesforceConnection): Promise<string> {
		if (!this.isTokenExpired(connection)) {
			return connection.access_token;
		}

		this.logger.log(`Token expired for holding ${connection.holding_id}, refreshing...`);
		const authData = await this.refreshAccessToken(connection);
		await this.updateTokens(connection.holding_id, authData);

		return authData.access_token;
	}

	async refreshAccessToken(connection: SalesforceConnection): Promise<SalesforceAuthResponse> {
		// CLIENT CREDENTIALS: Re-autenticar con client_id/client_secret
		if (connection.auth_type === SalesforceAuthType.CLIENT_CREDENTIALS) {
			this.logger.log(`Re-authenticating with Client Credentials for holding ${connection.holding_id}`);

			const params = new URLSearchParams({
				grant_type: 'client_credentials',
				client_id: connection.client_id,
				client_secret: connection.client_secret,
			});

			try {
				const response = await firstValueFrom(
					this.httpService.post(`${connection.login_url}/services/oauth2/token`, params.toString(), {
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
						},
					})
				);

				this.logger.log('✅ Client Credentials re-authentication successful');
				return response.data;
			} catch (error: any) {
				this.logger.error('❌ Client Credentials re-authentication failed:', error.response?.data || error.message);
				throw new Error(`Client Credentials re-authentication failed: ${error.response?.data?.error_description || error.message}`);
			}
		}

		// PASSWORD FLOW: Re-autenticar con SOAP (no usamos refresh_token porque SOAP no lo soporta)
		if (connection.auth_type === SalesforceAuthType.PASSWORD) {
			if (!connection.username || !connection.password || !connection.security_token) {
				throw new Error('No credentials available. Please use "Conectar y Validar" to establish a complete connection.');
			}

			this.logger.log(`Re-authenticating with SOAP for Password Flow, holding ${connection.holding_id}`);

			const decryptedPassword = this.encryptionService.decrypt(connection.password);

			try {
				const loginResult = await this.soapService.attemptLogin(
					connection.login_url,
					connection.username,
					decryptedPassword,
					connection.security_token
				);

				this.logger.log('✅ SOAP re-authentication successful');

				// Convertir resultado SOAP a formato AuthResponse
				const instanceUrl = loginResult.serverUrl.split('/services/')[0];
				return {
					access_token: loginResult.sessionId,
					instance_url: instanceUrl,
					id: loginResult.userId,
					token_type: 'Bearer',
					issued_at: Date.now().toString(),
					refresh_token: null, // SOAP no devuelve refresh_token
				};
			} catch (error: any) {
				this.logger.error('❌ SOAP re-authentication failed:', error.message);
				throw new Error(`SOAP re-authentication failed: ${error.message}`);
			}
		}

		// Si llegamos aquí, el auth_type no es reconocido
		throw new Error(`Unknown auth_type: ${connection.auth_type}`);
	}

	isTokenExpired(connection: SalesforceConnection): boolean {
		if (!connection.access_token) {
			return true;
		}

		if (connection.token_expires_at) {
			const bufferTime = 5 * 60 * 1000;
			return Date.now() >= new Date(connection.token_expires_at).getTime() - bufferTime;
		}

		if (!connection.token_issued_at) {
			return true;
		}

		const tokenAge = Date.now() - new Date(connection.token_issued_at).getTime();
		const twoHours = 2 * 60 * 60 * 1000;

		return tokenAge > twoHours;
	}

	async updateTokens(holdingId: string, authData: SalesforceAuthResponse): Promise<void> {
		const updateData: any = {
			access_token: authData.access_token,
			instance_url: authData.instance_url,
			token_issued_at: new Date(parseInt(authData.issued_at)),
			token_expires_at: authData.expires_in ? new Date(Date.now() + authData.expires_in * 1000) : null,
			last_sync_at: new Date(),
		};

		if (authData.refresh_token) {
			updateData.refresh_token = authData.refresh_token;
		}

		if (authData.id) {
			updateData.salesforce_user_id = authData.id;
		}

		await this.connectionRepository.update({ holding_id: holdingId }, updateData);
		this.logger.log(`Tokens updated for holding ${holdingId}`);
	}
}
