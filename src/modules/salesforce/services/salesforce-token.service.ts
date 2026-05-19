import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { SalesforceConnection } from '../entities/salesforce-connection.entity';
import { SalesforceAuthResponse } from '../interfaces/salesforce.interface';

@Injectable()
export class SalesforceTokenService {
	private readonly logger = new Logger(SalesforceTokenService.name);

	constructor(
		@InjectRepository(SalesforceConnection)
		private readonly connectionRepository: Repository<SalesforceConnection>,
		private readonly httpService: HttpService
	) {}

	async refreshAccessToken(connection: SalesforceConnection): Promise<SalesforceAuthResponse> {
		if (!connection.refresh_token) {
			throw new Error('No refresh token available');
		}

		this.logger.log(`Refreshing token for holding ${connection.holding_id}`);

		const params = new URLSearchParams({
			grant_type: 'refresh_token',
			client_id: connection.client_id,
			client_secret: connection.client_secret,
			refresh_token: connection.refresh_token,
		});

		try {
			const response = await firstValueFrom(
				this.httpService.post(`${connection.login_url}/services/oauth2/token`, params.toString(), {
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
				})
			);

			this.logger.log('✅ Token refreshed successfully');
			return response.data;
		} catch (error: any) {
			this.logger.error('❌ Token refresh failed:', error.response?.data || error.message);
			throw new Error(`Token refresh failed: ${error.response?.data?.error_description || error.message}`);
		}
	}

	isTokenExpired(connection: SalesforceConnection): boolean {
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
			token_issued_at: new Date(parseInt(authData.issued_at)),
			last_sync_at: new Date(),
		};

		if (authData.refresh_token) {
			updateData.refresh_token = authData.refresh_token;
		}

		await this.connectionRepository.update({ holding_id: holdingId }, updateData);
		this.logger.log(`Tokens updated for holding ${holdingId}`);
	}
}
