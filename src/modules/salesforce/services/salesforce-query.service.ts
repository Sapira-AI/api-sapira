import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { SalesforceConnection } from '../entities/salesforce-connection.entity';
import { SalesforceQueryResult } from '../interfaces/salesforce.interface';

import { SalesforceTokenService } from './salesforce-token.service';

@Injectable()
export class SalesforceQueryService {
	private readonly logger = new Logger(SalesforceQueryService.name);

	constructor(
		@InjectRepository(SalesforceConnection)
		private readonly connectionRepository: Repository<SalesforceConnection>,
		private readonly tokenService: SalesforceTokenService,
		private readonly httpService: HttpService
	) {}

	async executeQuery(soql: string, holdingId: string): Promise<{ data: SalesforceQueryResult; tokenRefreshed: boolean }> {
		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId, is_active: true },
		});

		if (!connection) {
			throw new NotFoundException('No active Salesforce connection found');
		}

		this.logger.log(`Executing SOQL query for holding ${holdingId}`);

		let tokenRefreshed = false;

		try {
			const result = await this.executeQueryWithToken(soql, connection);
			await this.updateLastSync(holdingId);
			return { data: result, tokenRefreshed };
		} catch (error: any) {
			if (error.response?.status === 401 && connection.refresh_token) {
				this.logger.log('Token expired, attempting refresh...');

				try {
					const authData = await this.tokenService.refreshAccessToken(connection);
					await this.tokenService.updateTokens(holdingId, authData);

					connection.access_token = authData.access_token;
					const result = await this.executeQueryWithToken(soql, connection);
					await this.updateLastSync(holdingId);

					tokenRefreshed = true;
					return { data: result, tokenRefreshed };
				} catch (refreshError: any) {
					this.logger.error('Token refresh failed, marking connection as inactive');
					await this.connectionRepository.update({ holding_id: holdingId }, { is_active: false });
					throw new Error('Salesforce token expired. Please reconnect.');
				}
			}

			throw this.handleQueryError(error);
		}
	}

	private async executeQueryWithToken(soql: string, connection: SalesforceConnection): Promise<SalesforceQueryResult> {
		const queryUrl = this.buildQueryUrl(connection.instance_url, soql);

		const response = await firstValueFrom(
			this.httpService.get(queryUrl, {
				headers: {
					Authorization: `Bearer ${connection.access_token}`,
					'Content-Type': 'application/json',
				},
			})
		);

		return response.data;
	}

	buildQueryUrl(instanceUrl: string, soql: string): string {
		return `${instanceUrl}/services/data/v58.0/query?q=${encodeURIComponent(soql)}`;
	}

	private handleQueryError(error: any): Error {
		const errorData = error.response?.data;

		if (Array.isArray(errorData) && errorData.length > 0) {
			const sfError = errorData[0];
			return new Error(sfError.message || 'Salesforce query failed');
		}

		if (typeof errorData === 'object' && errorData.message) {
			return new Error(errorData.message);
		}

		return new Error(error.message || 'Salesforce query failed');
	}

	private async updateLastSync(holdingId: string): Promise<void> {
		await this.connectionRepository.update({ holding_id: holdingId }, { last_sync_at: new Date() });
	}
}
