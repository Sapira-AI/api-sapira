import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { BigQueryConnection } from '@/databases/postgresql/entities/bigquery-connection.entity';

import { BigQueryService } from './bigquery.service';
import { BigQueryConnectionResponseDto } from './dtos/bigquery-connection-response.dto';
import { CreateBigQueryConnectionDto } from './dtos/create-bigquery-connection.dto';
import { TestConnectionResponseDto } from './dtos/test-connection-response.dto';
import { UpdateBigQueryConnectionDto } from './dtos/update-bigquery-connection.dto';

@ApiTags('BigQuery Connections')
@Controller('bigquery-connections')
@UseGuards(SupabaseAuthGuard)
export class BigQueryConnectionController {
	constructor(
		@InjectRepository(BigQueryConnection)
		private readonly bigQueryConnectionRepository: Repository<BigQueryConnection>,
		private readonly bigQueryService: BigQueryService
	) {}

	@Post()
	@ApiOperation({
		summary: 'Crear una nueva conexión de BigQuery',
		description: 'Crea una nueva configuración de conexión a BigQuery para el holding actual',
	})
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Conexión creada exitosamente',
		type: BigQueryConnectionResponseDto,
	})
	@HttpCode(HttpStatus.CREATED)
	async create(
		@Body() createDto: CreateBigQueryConnectionDto,
		@Headers('x-holding-id') holdingId: string,
		@Headers('x-user-id') userId: string
	): Promise<BigQueryConnectionResponseDto> {
		const connection = this.bigQueryConnectionRepository.create({
			...createDto,
			holding_id: holdingId,
			user_id: userId,
		});

		const saved = await this.bigQueryConnectionRepository.save(connection);

		return this.toResponseDto(saved);
	}

	@Get()
	@ApiOperation({
		summary: 'Listar conexiones de BigQuery',
		description: 'Obtiene todas las conexiones de BigQuery del holding actual',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de conexiones obtenida exitosamente',
		type: [BigQueryConnectionResponseDto],
	})
	async findAll(@Headers('x-holding-id') holdingId: string): Promise<BigQueryConnectionResponseDto[]> {
		const connections = await this.bigQueryConnectionRepository.find({
			where: { holding_id: holdingId },
			order: { created_at: 'DESC' },
		});

		return connections.map((conn) => this.toResponseDto(conn));
	}

	@Get(':id')
	@ApiOperation({
		summary: 'Obtener una conexión de BigQuery',
		description: 'Obtiene los detalles de una conexión específica',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión obtenida exitosamente',
		type: BigQueryConnectionResponseDto,
	})
	async findOne(@Param('id') id: string, @Headers('x-holding-id') holdingId: string): Promise<BigQueryConnectionResponseDto> {
		const connection = await this.bigQueryConnectionRepository.findOne({
			where: { id, holding_id: holdingId },
		});

		if (!connection) {
			throw new Error('Conexión no encontrada');
		}

		return this.toResponseDto(connection);
	}

	@Put(':id')
	@ApiOperation({
		summary: 'Actualizar una conexión de BigQuery',
		description: 'Actualiza la configuración de una conexión existente',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión actualizada exitosamente',
		type: BigQueryConnectionResponseDto,
	})
	async update(
		@Param('id') id: string,
		@Body() updateDto: UpdateBigQueryConnectionDto,
		@Headers('x-holding-id') holdingId: string
	): Promise<BigQueryConnectionResponseDto> {
		const connection = await this.bigQueryConnectionRepository.findOne({
			where: { id, holding_id: holdingId },
		});

		if (!connection) {
			throw new Error('Conexión no encontrada');
		}

		await this.bigQueryConnectionRepository.update(id, updateDto);

		const updated = await this.bigQueryConnectionRepository.findOne({
			where: { id },
		});

		return this.toResponseDto(updated);
	}

	@Delete(':id')
	@ApiOperation({
		summary: 'Eliminar una conexión de BigQuery',
		description: 'Elimina una conexión de BigQuery del holding',
	})
	@ApiResponse({
		status: HttpStatus.NO_CONTENT,
		description: 'Conexión eliminada exitosamente',
	})
	@HttpCode(HttpStatus.NO_CONTENT)
	async remove(@Param('id') id: string, @Headers('x-holding-id') holdingId: string): Promise<void> {
		const connection = await this.bigQueryConnectionRepository.findOne({
			where: { id, holding_id: holdingId },
		});

		if (!connection) {
			throw new Error('Conexión no encontrada');
		}

		await this.bigQueryConnectionRepository.delete(id);
	}

	@Post(':id/test')
	@ApiOperation({
		summary: 'Probar conexión de BigQuery',
		description: 'Verifica que la conexión a BigQuery funcione correctamente',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Resultado de la prueba de conexión',
		type: TestConnectionResponseDto,
	})
	async testConnection(@Param('id') id: string, @Headers('x-holding-id') holdingId: string): Promise<TestConnectionResponseDto> {
		const connection = await this.bigQueryConnectionRepository.findOne({
			where: { id, holding_id: holdingId },
		});

		if (!connection) {
			return {
				success: false,
				message: 'Conexión no encontrada',
				error: 'La conexión especificada no existe',
			};
		}

		try {
			const client = await this.bigQueryService.getBigQueryClientForHolding(holdingId);

			if (!client) {
				return {
					success: false,
					message: 'No se pudo inicializar el cliente de BigQuery',
					error: 'Error al crear el cliente con las credenciales proporcionadas',
				};
			}

			const [datasets] = await client.getDatasets();

			return {
				success: true,
				message: 'Conexión exitosa',
				project_id: connection.project_id,
				datasets_count: datasets.length,
			};
		} catch (error) {
			return {
				success: false,
				message: 'Error al conectar con BigQuery',
				error: error.message,
			};
		}
	}

	private toResponseDto(connection: BigQueryConnection): BigQueryConnectionResponseDto {
		return {
			id: connection.id,
			holding_id: connection.holding_id,
			user_id: connection.user_id,
			name: connection.name,
			project_id: connection.project_id,
			dataset_id: connection.dataset_id,
			is_active: connection.is_active,
			last_sync_at: connection.last_sync_at,
			created_at: connection.created_at,
			updated_at: connection.updated_at,
		};
	}
}
