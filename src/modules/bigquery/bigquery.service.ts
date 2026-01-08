import { BigQuery } from '@google-cloud/bigquery';
import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { QueryDto } from './dtos/query.dto';
import { BigQueryResult } from './interfaces/bigquery-result.interface';
import { ProjectInfo } from './interfaces/project-info.interface';

@Injectable()
export class BigQueryService {
	private readonly logger = new Logger(BigQueryService.name);
	private bigQueryClient: BigQuery;
	private projectId: string | null = null;
	private clientEmail: string | null = null;

	constructor(private readonly configService: ConfigService) {
		this.initializeBigQuery();
	}

	private initializeBigQuery() {
		try {
			const credentials = this.configService.get<string>('BIGQUERY_CREDENTIALS');

			if (!credentials) {
				this.logger.warn('⚠️ BIGQUERY_CREDENTIALS no configurado en variables de entorno');
				return;
			}

			this.logger.log(`Credenciales encontradas, longitud: ${credentials.length}`);

			const credentialsJson = JSON.parse(credentials);

			this.projectId = credentialsJson.project_id;
			this.clientEmail = credentialsJson.client_email;

			this.bigQueryClient = new BigQuery({
				projectId: this.projectId,
				credentials: {
					client_email: this.clientEmail,
					private_key: credentialsJson.private_key,
				},
			});

			this.logger.log(`✓ BigQuery inicializado para proyecto: ${this.projectId}`);
		} catch (error) {
			this.logger.error('Error inicializando BigQuery:', error);
			this.logger.error('Error detalle:', error.message);
		}
	}

	async executeQuery(dto: QueryDto): Promise<BigQueryResult> {
		if (!this.bigQueryClient) {
			throw new BadRequestException('BigQuery no está configurado. Contacte al administrador.');
		}

		try {
			this.logger.log(`Ejecutando consulta: ${dto.query.substring(0, 100)}...`);

			const options = {
				query: dto.query,
				params: dto.params || {},
				location: 'US',
			};

			const [rows] = await this.bigQueryClient.query(options);

			this.logger.log(`✓ Consulta ejecutada exitosamente. Filas: ${rows.length}`);

			return {
				rows,
				totalRows: rows.length,
				schema: rows.length > 0 ? Object.keys(rows[0]).map((key) => ({ name: key })) : [],
			};
		} catch (error) {
			this.logger.error('Error ejecutando consulta en BigQuery:', error);
			throw new InternalServerErrorException(`Error al ejecutar consulta: ${error.message}`);
		}
	}

	async getDatasets(): Promise<string[]> {
		if (!this.bigQueryClient) {
			throw new BadRequestException('BigQuery no está configurado. Contacte al administrador.');
		}

		try {
			this.logger.log('Solicitando datasets a BigQuery...');
			const [datasets] = await this.bigQueryClient.getDatasets();
			const datasetIds = datasets.map((dataset) => dataset.id);

			this.logger.log(`✓ Datasets obtenidos: ${datasetIds.length}`);

			return datasetIds;
		} catch (error) {
			this.logger.error('Error obteniendo datasets:', error);
			this.logger.error('Error mensaje:', error.message);
			this.logger.error('Error stack:', error.stack);
			throw new InternalServerErrorException(`Error al obtener datasets: ${error.message}`);
		}
	}

	async getTables(datasetId: string): Promise<string[]> {
		if (!this.bigQueryClient) {
			throw new BadRequestException('BigQuery no está configurado. Contacte al administrador.');
		}

		try {
			const dataset = this.bigQueryClient.dataset(datasetId);
			const [tables] = await dataset.getTables();
			const tableIds = tables.map((table) => table.id);

			this.logger.log(`✓ Tablas obtenidas del dataset ${datasetId}: ${tableIds.length}`);

			return tableIds;
		} catch (error) {
			this.logger.error(`Error obteniendo tablas del dataset ${datasetId}:`, error);
			throw new InternalServerErrorException('Error al obtener tablas');
		}
	}

	getProjectInfo(): ProjectInfo {
		return {
			projectId: this.projectId || 'No configurado',
			clientEmail: this.clientEmail || 'No configurado',
			isConfigured: !!this.bigQueryClient,
		};
	}
}
