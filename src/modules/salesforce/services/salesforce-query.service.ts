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

	/**
	 * Ejecuta una consulta SOQL resolviendo el token de la conexión del holding.
	 *
	 * La validación de token de `ensureValidToken` es proactiva: se basa en el
	 * reloj local. Cuando Salesforce rechaza un token que localmente parecía
	 * vigente —sesión revocada, timeout de la org menor al heurístico, cambio de
	 * política o restricción de IP— se fuerza una re-autenticación y se reintenta
	 * una única vez antes de dar la autenticación por perdida.
	 */
	async executeQuery(
		soql: string,
		holdingId: string,
		options: { isRetry?: boolean } = {}
	): Promise<{ data: SalesforceQueryResult; tokenRefreshed: boolean }> {
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
			const completeResult = await this.fetchAllQueryPages(result, connection.instance_url, accessToken);
			await this.updateLastSync(holdingId);

			return { data: completeResult, tokenRefreshed: wasExpired || Boolean(options.isRetry) };
		} catch (error: any) {
			if (error.response?.status === 401 && !options.isRetry) {
				this.logger.warn(`Salesforce rechazó el token del holding ${holdingId}; forzando re-autenticación y reintentando`);

				try {
					const authData = await this.tokenService.refreshAccessToken(connection);
					await this.tokenService.updateTokens(holdingId, authData);
				} catch (refreshError: any) {
					this.logger.error(`No se pudo re-autenticar el holding ${holdingId}: ${refreshError.message}`);
					throw new Error(`Salesforce authentication failed and re-authentication was not possible: ${refreshError.message}`);
				}

				return this.executeQuery(soql, holdingId, { isRetry: true });
			}

			if (error.response?.status === 401) {
				// La conexión NO se desactiva: dejar el holding fuera del barrido automático
				// de forma permanente y silenciosa es peor que fallar hoy y reintentar mañana.
				// El fallo se notifica desde SalesforceSyncCompleteService y queda en la bitácora.
				this.logger.error(`Autenticación Salesforce fallida tras re-autenticar el holding ${holdingId}`);
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

	private async fetchAllQueryPages(initialResult: SalesforceQueryResult, instanceUrl: string, accessToken: string): Promise<SalesforceQueryResult> {
		const records = [...(initialResult.records || [])];
		let nextRecordsUrl = initialResult.nextRecordsUrl;

		while (nextRecordsUrl) {
			const response = await firstValueFrom(
				this.httpService.get(`${instanceUrl}${nextRecordsUrl}`, {
					headers: {
						Authorization: `Bearer ${accessToken}`,
						'Content-Type': 'application/json',
					},
				})
			);
			const page = response.data as SalesforceQueryResult;
			records.push(...(page.records || []));
			nextRecordsUrl = page.nextRecordsUrl;
		}

		return {
			...initialResult,
			records,
			done: true,
			nextRecordsUrl: undefined,
		};
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
