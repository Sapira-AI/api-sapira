import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PipelineStage } from 'mongoose';

import { AzureADAuthGuard } from '@/auth/strategies/azuread-auth.guard';
import { PaginatedResponseDTO } from '@/core/dto/pagination.dto';
import { PaginationDTO } from '@/core/dto/pagination.dto';
import { BaseResponse } from '@/core/interfaces/base/base.interface';

import { AuditService } from './audit.service';
import { AuditFilterDTO } from './dto/audit-filter.dto';
import { CreateAuditDto } from './dto/create-audit.dto';
import { Audit, AuditDocument } from './schemas/audit.schema';

@ApiTags('Audit')
@Controller('audit')
@UseGuards(AzureADAuthGuard)
@ApiBearerAuth()
export class AuditController {
	constructor(private readonly auditService: AuditService) {}

	@Post('register')
	@ApiOperation({ summary: 'Registrar un evento de auditoría' })
	@ApiResponse({ status: 201, description: 'Evento registrado correctamente' })
	async registerEvent(@Body() createAuditDto: CreateAuditDto, @Req() req: Request): Promise<BaseResponse<AuditDocument>> {
		return this.auditService.registrarEvento(
			createAuditDto.userId,
			createAuditDto.eventType,
			createAuditDto.action,
			createAuditDto.resourceType,
			createAuditDto.resourceId,
			createAuditDto.details,
			req.deviceInfo || {},
			req,
			req.body,
			req.params
		);
	}

	@Get()
	@ApiOperation({ summary: 'Obtener registros de auditoría con filtros y paginación' })
	@ApiResponse({ status: 200, description: 'Registros de auditoría encontrados' })
	async getAuditRecords(@Query() filterDto: AuditFilterDTO): Promise<PaginatedResponseDTO<Audit>> {
		// Construir el filtro basado en los parámetros recibidos
		const filter: any = {};

		// Filtrar por usuario si se proporciona
		if (filterDto.userId) {
			filter.userId = filterDto.userId;
		}

		// Filtrar por tipo de evento si se proporciona
		if (filterDto.eventType) {
			filter.eventType = filterDto.eventType;
		}

		// Filtrar por rango de fechas si se proporciona
		if (filterDto.startDate || filterDto.endDate) {
			// Crear fechas para el filtrado
			let startDate, endDate;

			if (filterDto.startDate) {
				// Crear fecha en la zona horaria local
				const [year, month, day] = filterDto.startDate.split('-').map(Number);
				startDate = new Date(year, month - 1, day, 0, 0, 0, 0);
				console.log('Fecha de inicio convertida:', startDate);
			}

			if (filterDto.endDate) {
				// Crear fecha en la zona horaria local
				const [year, month, day] = filterDto.endDate.split('-').map(Number);
				endDate = new Date(year, month - 1, day, 23, 59, 59, 999);
				console.log('Fecha de fin convertida:', endDate);
			}

			// Construir el filtro usando $or para incluir múltiples condiciones
			const dateConditions = [];

			// Condición 1: El timestamp está dentro del rango de fechas
			const timestampCondition: any = {};
			if (startDate) timestampCondition.$gte = startDate;
			if (endDate) timestampCondition.$lte = endDate;
			if (Object.keys(timestampCondition).length > 0) {
				dateConditions.push({ timestamp: timestampCondition });
			}

			// Condición 2: El registro tiene un endDate que cae dentro del rango de fechas
			const endDateCondition: any = {};
			if (startDate) endDateCondition.$gte = startDate;
			if (endDate) endDateCondition.$lte = endDate;
			if (Object.keys(endDateCondition).length > 0) {
				dateConditions.push({ endDate: endDateCondition });
			}

			// Condición 3: El registro tiene un startDate antes o durante el rango y no tiene endDate
			// O el registro tiene un startDate antes o durante el rango y un endDate después del rango
			if (startDate || endDate) {
				const rangeOverlapCondition: any = {};

				// Si hay fecha de inicio, buscar registros que empiecen antes o durante el rango
				if (endDate) {
					rangeOverlapCondition.startDate = { $lte: endDate };

					// Y que no tengan fecha de fin o que terminen después del rango
					const noEndDateOrAfterRange: any = {
						$or: [{ endDate: { $exists: false } }],
					};

					// Si hay fecha de inicio, también incluir los que terminan después de ella
					if (startDate) {
						noEndDateOrAfterRange.$or.push({ endDate: { $gt: startDate } });
					}

					// Combinar las condiciones
					dateConditions.push({
						$and: [rangeOverlapCondition, noEndDateOrAfterRange],
					});
				}
			}

			// Añadir la condición OR para fechas al filtro principal
			if (dateConditions.length > 0) {
				filter.$or = filter.$or || [];
				filter.$or = filter.$or.concat(dateConditions);
			}
		}

		// Variable para indicar si estamos buscando por texto
		let searchingByText = false;

		// Filtrar por texto de búsqueda si se proporciona
		if (filterDto.search) {
			searchingByText = true;
			// Solo buscar en el campo details inicialmente
			filter.details = { $regex: filterDto.search, $options: 'i' };
		}

		// Calcular skip para paginación
		const skip = (filterDto.page - 1) * filterDto.limit;

		// Consultar los registros de auditoría
		const auditModel = this.auditService.getAuditModel();
		let total = await auditModel.countDocuments(filter);

		// Si estamos buscando por texto, usamos agregación para buscar también en los campos del usuario
		let auditEvents = [];
		let query;

		if (searchingByText) {
			// Eliminar la condición de details del filtro original para la agregación
			const aggregationFilter = { ...filter };
			delete aggregationFilter.details;

			// Crear un pipeline de agregación para buscar en los campos del usuario
			const pipeline: PipelineStage[] = [
				// Etapa 1: Filtrar por los criterios básicos (excepto details)
				{ $match: aggregationFilter } as PipelineStage,

				// Etapa 2: Hacer lookup para obtener los datos del usuario
				{
					$lookup: {
						from: 'users', // Nombre de la colección de usuarios
						localField: 'userId',
						foreignField: '_id',
						as: 'userInfo',
					},
				} as PipelineStage,

				// Etapa 3: Descomponer el array de userInfo
				{ $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } } as PipelineStage,

				// Etapa 4: Filtrar por texto en details o en los campos del usuario
				{
					$match: {
						$or: [
							{ details: { $regex: filterDto.search, $options: 'i' } },
							{ 'userInfo.name': { $regex: filterDto.search, $options: 'i' } },
							{ 'userInfo.fatherName': { $regex: filterDto.search, $options: 'i' } },
							{ 'userInfo.email': { $regex: filterDto.search, $options: 'i' } },
						],
					},
				} as PipelineStage,

				// Etapa 5: Contar documentos para paginación
				{
					$facet: {
						metadata: [{ $count: 'total' }],
						data: [
							{ $sort: { timestamp: -1 } },
							{ $skip: skip },
							{ $limit: filterDto.limit },
							// Proyectar los campos necesarios
							{
								$project: {
									_id: 1,
									userId: 1,
									eventType: 1,
									action: 1,
									resourceType: 1,
									resourceId: 1,
									details: 1,
									deviceInfo: 1,
									timestamp: 1,
									userInfo: {
										_id: '$userInfo._id',
										name: '$userInfo.name',
										fatherName: '$userInfo.fatherName',
										email: '$userInfo.email',
									},
								},
							},
						],
					},
				} as PipelineStage,
			];

			// Ejecutar la agregación
			const aggregationResult = await auditModel.aggregate(pipeline);

			// Extraer los resultados
			const metadata = aggregationResult[0].metadata[0] || { total: 0 };
			total = metadata.total;

			// Formatear los resultados para que sean compatibles con el formato esperado
			auditEvents = aggregationResult[0].data.map((item) => {
				return {
					...item,
					userId: item.userInfo, // Reemplazar userId con el objeto completo del usuario
				};
			});
		} else {
			// Consulta estándar sin búsqueda en campos de usuario
			query = auditModel.find(filter).sort({ timestamp: -1 }).skip(skip).limit(filterDto.limit);
			query = query.populate('userId', 'name fatherName email');

			// Ejecutar la consulta
			auditEvents = await query.lean();
		}

		// Devolver los resultados en formato paginado
		return {
			data: auditEvents,
			items: total,
			pages: Math.ceil(total / filterDto.limit),
			currentPage: filterDto.page,
			limit: filterDto.limit,
		};
	}

	@Get('user/:userId')
	@ApiOperation({ summary: 'Obtener registros de auditoría por usuario' })
	@ApiParam({ name: 'userId', description: 'ID del usuario' })
	@ApiResponse({ status: 200, description: 'Registros de auditoría encontrados' })
	async getUserAudit(@Param('userId') userId: string, @Query() filterDto: AuditFilterDTO): Promise<PaginatedResponseDTO<Audit>> {
		// Asignar el userId al filtro
		filterDto.userId = userId;

		// Reutilizar el método principal de consulta
		return this.getAuditRecords(filterDto);
	}

	@Delete('user/:userId')
	@ApiOperation({ summary: 'Eliminar todos los registros de auditoría de un usuario' })
	@ApiParam({ name: 'userId', description: 'ID del usuario cuyos registros se eliminarán' })
	@ApiResponse({ status: 200, description: 'Registros de auditoría eliminados correctamente' })
	@ApiResponse({ status: 400, description: 'ID de usuario inválido' })
	@ApiResponse({ status: 500, description: 'Error interno del servidor' })
	async deleteUserAudit(@Param('userId') userId: string): Promise<BaseResponse<{ deletedCount: number }>> {
		return this.auditService.eliminarRegistrosUsuario(userId);
	}

	@Get('resource/:resourceType/:resourceId')
	@ApiOperation({ summary: 'Obtener registros de auditoría por recurso' })
	@ApiParam({ name: 'resourceType', description: 'Tipo de recurso (ej: investment-call)' })
	@ApiParam({ name: 'resourceId', description: 'ID del recurso' })
	@ApiResponse({ status: 200, description: 'Registros de auditoría encontrados' })
	async getResourceAudit(
		@Param('resourceType') resourceType: string,
		@Param('resourceId') resourceId: string,
		@Query() paginationDto: PaginationDTO
	): Promise<PaginatedResponseDTO<Audit>> {
		// Construir el filtro para buscar en el campo details
		const filter: any = {
			details: {
				$regex: `resourceType\":\"${resourceType}\"|resourceId\":\"${resourceId}\"`,
				$options: 'i',
			},
		};

		// Calcular skip para paginación
		const skip = (paginationDto.page - 1) * paginationDto.limit;

		// Consultar los registros de auditoría
		const auditModel = this.auditService.getAuditModel();
		const total = await auditModel.countDocuments(filter);
		const auditEvents = await auditModel.find(filter).sort({ timestamp: -1 }).skip(skip).limit(paginationDto.limit).lean();

		// Devolver los resultados en formato paginado
		return {
			data: auditEvents,
			items: total,
			pages: Math.ceil(total / paginationDto.limit),
			currentPage: paginationDto.page,
			limit: paginationDto.limit,
		};
	}
}
