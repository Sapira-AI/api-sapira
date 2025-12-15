import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';

import { BaseResponse } from '@/core/interfaces/base/base.interface';
import { BaseService } from '@/core/services/base/base.service';

import { EventNames } from './constants/event-names';
import { ApiCallProperties, AuthEventProperties, BaseTelemetryProperties, DocumentEventProperties } from './interfaces/telemetry-event.interface';

export type AuthEventName =
	| typeof EventNames.Auth.Login.Start
	| typeof EventNames.Auth.Login.Success
	| typeof EventNames.Auth.Login.Failure
	| typeof EventNames.Auth.Logout.Success
	| typeof EventNames.Auth.DeviceChange;

export type DocumentEventName =
	| typeof EventNames.Document.Process.Start
	| typeof EventNames.Document.Process.Complete
	| typeof EventNames.Document.Process.Error
	| typeof EventNames.Document.View.Start
	| typeof EventNames.Document.View.Complete
	| typeof EventNames.Document.View.Error
	| typeof EventNames.Document.Download.Start
	| typeof EventNames.Document.Download.Complete
	| typeof EventNames.Document.Download.Error;

@Injectable()
export class TelemetryService extends BaseService {
	private readonly environment: string;
	private readonly version: string;

	constructor() {
		super();
		this.environment = process.env.NODE_ENV || 'development';
		this.version = process.env.APP_VERSION || '1.0.0';
		console.log('TelemetryService initialized without Application Insights');
	}

	private getBaseProperties(userId: string): BaseTelemetryProperties {
		return {
			userId: userId || 'anonymous',
			timestamp: new Date().toISOString(),
			correlationId: uuid(),
			environment: this.environment,
			version: this.version,
		};
	}

	private sanitizeProperties(properties: Record<string, any>): Record<string, string> {
		const sanitized: Record<string, string> = {};
		for (const [key, value] of Object.entries(properties)) {
			sanitized[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
		}
		return sanitized;
	}

	async trackApiCall(userId: string, properties: Omit<ApiCallProperties, keyof BaseTelemetryProperties>): Promise<BaseResponse<void>> {
		try {
			const baseProps = this.getBaseProperties(userId);
			// Log to console instead of Application Insights
			console.log('API Call Tracked:', {
				name: EventNames.Api.Call,
				properties: {
					...baseProps,
					...properties,
				},
			});
			return this.createSuccessResponse<void>(undefined);
		} catch (error) {
			return this.handleError(error, {
				context: 'TelemetryService.trackApiCall',
				metadata: { userId, properties },
			});
		}
	}

	async trackAuthEvent(
		userId: string,
		eventName: AuthEventName,
		properties: Omit<AuthEventProperties, keyof BaseTelemetryProperties>
	): Promise<BaseResponse<void>> {
		try {
			const baseProps = this.getBaseProperties(userId);
			// Log to console instead of Application Insights
			console.log('Auth Event Tracked:', {
				name: eventName,
				properties: {
					...baseProps,
					...properties,
				},
			});
			return this.createSuccessResponse<void>(undefined);
		} catch (error) {
			return this.handleError(error, {
				context: 'TelemetryService.trackAuthEvent',
				metadata: { userId, eventName, properties },
			});
		}
	}

	async trackDocumentEvent(
		userId: string,
		eventName: DocumentEventName,
		properties: Omit<DocumentEventProperties, keyof BaseTelemetryProperties>
	): Promise<BaseResponse<void>> {
		try {
			const baseProps = this.getBaseProperties(userId);
			// Log to console instead of Application Insights
			console.log('Document Event Tracked:', {
				name: eventName,
				properties: {
					...baseProps,
					...properties,
				},
			});
			return this.createSuccessResponse<void>(undefined);
		} catch (error) {
			return this.handleError(error, {
				context: 'TelemetryService.trackDocumentEvent',
				metadata: { userId, eventName, properties },
			});
		}
	}

	async trackSecurityEvent(userId: string, properties: Record<string, any>): Promise<BaseResponse<void>> {
		try {
			const baseProps = this.getBaseProperties(userId);
			// Log to console instead of Application Insights
			console.log('Security Event Tracked:', {
				name: 'SecurityEvent',
				properties: {
					...baseProps,
					...properties,
				},
			});
			return this.createSuccessResponse<void>(undefined);
		} catch (error) {
			return this.handleError(error, {
				context: 'TelemetryService.trackSecurityEvent',
				metadata: { userId, properties },
			});
		}
	}

	async trackException(error: Error, userId: string, properties?: Record<string, any>): Promise<BaseResponse<void>> {
		try {
			const baseProps = this.getBaseProperties(userId);
			// Log to console instead of Application Insights
			console.error('Exception Tracked:', {
				exception: {
					name: error.name,
					message: error.message,
					stack: error.stack,
				},
				properties: {
					...baseProps,
					errorType: error.name,
					errorMessage: error.message,
					errorStack: error.stack,
					...properties,
				},
			});
			return this.createSuccessResponse<void>(undefined);
		} catch (error) {
			return this.handleError(error, {
				context: 'TelemetryService.trackException',
				metadata: { userId, properties },
			});
		}
	}
}
