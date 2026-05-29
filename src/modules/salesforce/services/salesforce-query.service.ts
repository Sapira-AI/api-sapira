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
		let connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId, is_active: true },
		});

		if (!connection) {
			throw new NotFoundException('No active Salesforce connection found');
		}

		this.logger.log(`Executing SOQL query for holding ${holdingId}`);

		try {
			const wasExpired = this.tokenService.isTokenExpired(connection);
			const accessToken = await this.tokenService.ensureValidToken(connection);

			// Si el token fue refrescado, recargar la conexión para obtener instance_url actualizado
			if (wasExpired) {
				connection = await this.connectionRepository.findOne({
					where: { holding_id: holdingId, is_active: true },
				});

				if (!connection) {
					throw new NotFoundException('Connection lost after token refresh');
				}
			}

			if (!connection.instance_url) {
				throw new Error('No instance URL available. Please use "Conectar y Validar" to establish a complete connection.');
			}

			const result = await this.executeQueryWithToken(soql, connection.instance_url, accessToken);
			await this.updateLastSync(holdingId);

			return { data: result, tokenRefreshed: wasExpired };
		} catch (error: any) {
			if (error.response?.status === 401) {
				this.logger.error('Authentication failed even after token refresh, marking connection as inactive');
				await this.connectionRepository.update({ holding_id: holdingId }, { is_active: false });
				throw new Error('Salesforce authentication failed. Please reconnect.');
			}

			throw this.handleQueryError(error);
		}
	}

	private async executeQueryWithToken(soql: string, instanceUrl: string, accessToken: string): Promise<SalesforceQueryResult> {
		const queryUrl = this.buildQueryUrl(instanceUrl, soql);

		const response = await firstValueFrom(
			this.httpService.get(queryUrl, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
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
