import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { EncryptionService } from '@/common/services/encryption.service';

import { SalesforceAuthType, SalesforceConnection } from '../entities/salesforce-connection.entity';
import { SalesforceAuthResponse, SalesforceCredentials } from '../interfaces/salesforce.interface';

@Injectable()
export class SalesforceAuthService {
	private readonly logger = new Logger(SalesforceAuthService.name);

	constructor(
		@InjectRepository(SalesforceConnection)
		private readonly connectionRepository: Repository<SalesforceConnection>,
		private readonly httpService: HttpService,
		private readonly encryptionService: EncryptionService
	) {}

	async authenticate(credentials: SalesforceCredentials, holdingId: string): Promise<SalesforceAuthResponse> {
		const baseLoginUrl = credentials.loginUrl || 'https://login.salesforce.com';
		const passwordWithToken = `${credentials.password}${credentials.securityToken}`;

		const params = new URLSearchParams({
			grant_type: 'password',
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			username: credentials.username,
			password: passwordWithToken,
		});

		try {
			this.logger.log(`Authenticating with Salesforce for holding ${holdingId}`);

			const response = await firstValueFrom(
				this.httpService.post(`${baseLoginUrl}/services/oauth2/token`, params.toString(), {
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
				})
			);

			this.logger.log('✅ Salesforce authentication successful');
			this.logger.log(`📋 Response keys: ${Object.keys(response.data).join(', ')}`);
			this.logger.log(`� Full Salesforce response: ${JSON.stringify(response.data, null, 2)}`);
			this.logger.log(`� Has refresh_token: ${!!response.data.refresh_token}`);
			this.logger.log(`🔑 Has access_token: ${!!response.data.access_token}`);
			this.logger.log(`🔑 Has instance_url: ${!!response.data.instance_url}`);

			if (response.data.refresh_token) {
				this.logger.log(`✅ Refresh token received from Salesforce`);
			} else {
				this.logger.warn(
					`⚠️ No refresh token in Salesforce response. This is expected for Client Credentials flow, but NOT for Password flow.`
				);
			}

			return response.data;
		} catch (error: any) {
			this.logger.error('❌ Salesforce authentication failed:', error.response?.data || error.message);
			throw new Error(`Salesforce authentication failed: ${error.response?.data?.error_description || error.message}`);
		}
	}

	async storeConnection(
		authData: SalesforceAuthResponse,
		credentials: SalesforceCredentials,
		userId: string,
		holdingId: string
	): Promise<SalesforceConnection> {
		this.logger.log(`Storing Salesforce connection for holding ${holdingId}`);

		const connectionData = {
			user_id: userId,
			holding_id: holdingId,
			username: credentials.username,
			password: this.encryptionService.encrypt(credentials.password),
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			security_token: credentials.securityToken,
			login_url: credentials.loginUrl || 'https://login.salesforce.com',
			access_token: authData.access_token,
			refresh_token: authData.refresh_token,
			instance_url: authData.instance_url,
			salesforce_user_id: authData.id,
			token_issued_at: new Date(parseInt(authData.issued_at)),
			token_expires_at: authData.expires_in ? new Date(Date.now() + authData.expires_in * 1000) : null,
			auth_type: SalesforceAuthType.PASSWORD,
			is_active: true,
			last_sync_at: new Date(),
		};

		const existingConnection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId },
		});

		if (existingConnection) {
			await this.connectionRepository.update({ holding_id: holdingId }, connectionData);
			return this.connectionRepository.findOne({ where: { holding_id: holdingId } });
		}

		const connection = this.connectionRepository.create(connectionData);
		return this.connectionRepository.save(connection);
	}

	validateCredentials(credentials: SalesforceCredentials): void {
		if (!credentials.username || !credentials.password || !credentials.securityToken || !credentials.clientId || !credentials.clientSecret) {
			throw new Error('Missing required credentials');
		}
	}

	async authenticateWithClientCredentials(
		clientId: string,
		clientSecret: string,
		holdingId: string,
		loginUrl: string = 'https://login.salesforce.com'
	): Promise<SalesforceAuthResponse> {
		this.logger.log(`Authenticating with Client Credentials for holding ${holdingId}`);

		const params = new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: clientId,
			client_secret: clientSecret,
		});

		try {
			const response = await firstValueFrom(
				this.httpService.post(`${loginUrl}/services/oauth2/token`, params.toString(), {
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
				})
			);

			this.logger.log('✅ Client Credentials authentication successful');
			return response.data;
		} catch (error: any) {
			this.logger.error('❌ Client Credentials authentication failed:', error.response?.data || error.message);
			throw new Error(`Client Credentials authentication failed: ${error.response?.data?.error_description || error.message}`);
		}
	}

	async storeClientCredentialsConnection(
		authData: SalesforceAuthResponse,
		clientId: string,
		clientSecret: string,
		userId: string,
		holdingId: string,
		loginUrl: string
	): Promise<SalesforceConnection> {
		this.logger.log(`Storing Client Credentials connection for holding ${holdingId}`);

		const connectionData = {
			user_id: userId,
			holding_id: holdingId,
			username: null,
			client_id: clientId,
			client_secret: clientSecret,
			security_token: null,
			login_url: loginUrl,
			access_token: authData.access_token,
			refresh_token: null,
			instance_url: authData.instance_url,
			salesforce_user_id: authData.id || null,
			token_issued_at: new Date(parseInt(authData.issued_at)),
			token_expires_at: authData.expires_in ? new Date(Date.now() + authData.expires_in * 1000) : null,
			auth_type: SalesforceAuthType.CLIENT_CREDENTIALS,
			is_active: true,
			last_sync_at: new Date(),
		};

		const existingConnection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId },
		});

		if (existingConnection) {
			await this.connectionRepository.update({ holding_id: holdingId }, connectionData);
			return this.connectionRepository.findOne({ where: { holding_id: holdingId } });
		}

		const connection = this.connectionRepository.create(connectionData);
		return this.connectionRepository.save(connection);
	}

	async storeConnectionWithoutAuth(
		credentials: Partial<SalesforceCredentials> & { clientId: string; clientSecret: string },
		userId: string,
		holdingId: string,
		authType: SalesforceAuthType
	): Promise<SalesforceConnection> {
		this.logger.log(`Guardando credenciales sin autenticar para holding ${holdingId}, tipo: ${authType}`);

		const connectionData = {
			user_id: userId,
			holding_id: holdingId,
			username: authType === SalesforceAuthType.PASSWORD ? credentials.username : null,
			password: authType === SalesforceAuthType.PASSWORD && credentials.password ? this.encryptionService.encrypt(credentials.password) : null,
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			security_token: authType === SalesforceAuthType.PASSWORD ? credentials.securityToken : null,
			login_url: credentials.loginUrl || 'https://login.salesforce.com',
			access_token: null,
			refresh_token: null,
			instance_url: null,
			salesforce_user_id: null,
			token_issued_at: null,
			token_expires_at: null,
			auth_type: authType,
			is_active: true,
			last_sync_at: null,
		};

		const existingConnection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId },
		});

		if (existingConnection) {
			await this.connectionRepository.update({ holding_id: holdingId }, connectionData);
			return this.connectionRepository.findOne({ where: { holding_id: holdingId } });
		}

		const connection = this.connectionRepository.create(connectionData);
		return this.connectionRepository.save(connection);
	}

	async storeConnectionFromSOAP(
		soapResult: { sessionId: string; serverUrl: string; userId: string },
		credentials: SalesforceCredentials,
		userId: string,
		holdingId: string
	): Promise<SalesforceConnection> {
		this.logger.log(`Storing SOAP connection for holding ${holdingId}`);

		// Extraer instance_url del serverUrl
		// serverUrl formato: https://simpliroute.my.salesforce.com/services/Soap/u/58.0/00D5w000000Wn65
		const instanceUrl = soapResult.serverUrl.split('/services/')[0];

		const connectionData = {
			user_id: userId,
			holding_id: holdingId,
			username: credentials.username,
			password: this.encryptionService.encrypt(credentials.password),
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			security_token: credentials.securityToken,
			login_url: credentials.loginUrl || 'https://login.salesforce.com',
			access_token: soapResult.sessionId, // El sessionId de SOAP funciona como access_token
			refresh_token: null, // SOAP no devuelve refresh_token
			instance_url: instanceUrl,
			salesforce_user_id: soapResult.userId,
			token_issued_at: new Date(),
			token_expires_at: null, // SOAP tokens no tienen expiración explícita
			auth_type: SalesforceAuthType.PASSWORD,
			is_active: true,
			last_sync_at: new Date(),
		};

		const existingConnection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId },
		});

		if (existingConnection) {
			await this.connectionRepository.update({ holding_id: holdingId }, connectionData);
			return this.connectionRepository.findOne({ where: { holding_id: holdingId } });
		}

		const connection = this.connectionRepository.create(connectionData);
		return this.connectionRepository.save(connection);
	}
}
