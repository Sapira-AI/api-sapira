import { Injectable, Logger } from '@nestjs/common';

export interface BusinessOperationData {
	workspace?: string;
	success: boolean;
	userId: string;
	details?: any;
	duration?: number;
	operationType?: 'create' | 'update' | 'delete' | 'read' | 'process';
	resourceType?: string;
	errorDetails?: any;
}

@Injectable()
export class BusinessMetricsService {
	private readonly logger = new Logger(BusinessMetricsService.name);

	constructor() {
		this.logger.log('BusinessMetricsService initialized without Application Insights');
	}

	trackBusinessOperation(operation: string, data: BusinessOperationData) {
		// Log to console instead of Application Insights
		this.logger.log('Business Operation Tracked:', {
			name: 'BusinessOperation',
			operation,
			properties: {
				workspace: data.workspace,
				success: data.success.toString(),
				userId: data.userId,
				operationType: data.operationType,
				resourceType: data.resourceType,
				details: JSON.stringify(data.details),
				errorDetails: data.errorDetails ? JSON.stringify(data.errorDetails) : undefined,
				timestamp: new Date().toISOString(),
			},
			measurements: {
				duration: data.duration || 0,
			},
		});

		// Si la operación falló, también lo registramos
		if (!data.success) {
			this.logger.error('Business Operation Error:', {
				name: `BusinessOperation_Error_${operation}`,
				value: 1,
				properties: {
					workspace: data.workspace,
					userId: data.userId,
					errorType: data.errorDetails?.type,
					timestamp: new Date().toISOString(),
				},
			});
		}
	}

	// Método específico para operaciones de workspace
	trackWorkspaceOperation(workspaceId: string, operation: string, data: Partial<BusinessOperationData>) {
		this.trackBusinessOperation(operation, {
			...data,
			workspace: workspaceId,
			resourceType: 'workspace',
		} as BusinessOperationData);
	}

	// Método específico para operaciones de documentos
	trackDocumentOperation(documentId: string, operation: string, data: Partial<BusinessOperationData>) {
		this.trackBusinessOperation(operation, {
			...data,
			details: { documentId, ...data.details },
			resourceType: 'document',
		} as BusinessOperationData);
	}

	// Método para registrar métricas de rendimiento de operaciones
	trackOperationPerformance(operation: string, duration: number, success: boolean, details?: any) {
		// Log to console instead of Application Insights
		this.logger.log('Operation Performance Tracked:', {
			name: `Operation_Duration_${operation}`,
			value: duration,
			properties: {
				success: success.toString(),
				...details,
			},
		});
	}
}
