import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { Model } from 'mongoose';

import { Retry } from '@/core/decorators/retry.decorator';
import { EventSeverity, EventType, SecurityEvent } from '@/core/interfaces/events/event.interface';
import { SecurityViolationType } from '@/core/interfaces/security/security.types';
import { EventEnricherService } from '@/core/services/event-enricher.service';
import { AppLoggerService } from '@/logger/app-logger.service';

import { IpList } from '../schemas/ip-list.schema';

@Injectable()
export class SecurityService {
	constructor(
		@Inject('IpListModelToken')
		private ipListModel: Model<IpList>,
		private readonly logger: AppLoggerService,
		private readonly eventEnricher: EventEnricherService,
		private readonly configService: ConfigService
	) {}

	@Retry()
	async addToList(ip: string, listType: 'whitelist' | 'blacklist', reason?: string, expiresAt?: Date, points: number = 0) {
		try {
			const ipList = await this.ipListModel.findOneAndUpdate(
				{ ip, listType },
				{
					ip,
					listType,
					reason,
					expiresAt,
					points,
					isActive: true,
					addedBy: 'system',
					timestamp: new Date(),
					metadata: {
						reason,
						action: `Added to ${listType}`,
					},
				},
				{ upsert: true, new: true }
			);

			const securityEvent: Partial<SecurityEvent> = {
				type: EventType.SECURITY,
				violationType: listType === 'blacklist' ? SecurityViolationType.IP_BLACKLISTED : SecurityViolationType.UNAUTHORIZED_ACCESS,
				points,
				ipAddress: ip,
				metadata: {
					reason,
					expiresAt,
					action: `Added to ${listType}`,
					listType,
				},
			};

			const enrichedEvent = this.eventEnricher.enrichEvent(securityEvent);
			await this.logger.logSecurityViolation(ip, {
				type: enrichedEvent.violationType,
				points: enrichedEvent.points,
				details: enrichedEvent.metadata,
			});

			return ipList;
		} catch (error) {
			this.logger.error(`Error adding IP ${ip} to ${listType}`, error);
			throw error;
		}
	}

	@Retry()
	async removeFromList(ip: string, listType: 'whitelist' | 'blacklist') {
		try {
			const result = await this.ipListModel.findOneAndUpdate(
				{ ip, listType },
				{
					isActive: false,
					timestamp: new Date(),
					metadata: {
						action: `Removed from ${listType}`,
						reason: 'Manual removal',
					},
				},
				{ new: true }
			);

			if (result) {
				const securityEvent: Partial<SecurityEvent> = {
					type: EventType.SECURITY,
					violationType: SecurityViolationType.UNAUTHORIZED_ACCESS,
					points: 0,
					ipAddress: ip,
					metadata: {
						listType,
						reason: 'Manual removal',
						action: `Removed from ${listType}`,
					},
				};

				const enrichedEvent = this.eventEnricher.enrichEvent(securityEvent);
				await this.logger.logSecurityViolation(ip, {
					type: enrichedEvent.violationType,
					points: enrichedEvent.points,
					details: enrichedEvent.metadata,
				});
			}

			return result;
		} catch (error) {
			this.logger.error(`Error removing IP ${ip} from ${listType}`, error);
			throw error;
		}
	}

	async checkIpStatus(ip: string): Promise<{ isBlocked: boolean; points: number }> {
		try {
			const points = await this.getPoints(ip);
			const thresholds = this.configService.get('events.security.pointThresholds') || { low: 10, medium: 50, high: 100 };
			const isBlocked = points >= thresholds.high;

			if (isBlocked) {
				const securityEvent: Partial<SecurityEvent> = {
					type: EventType.SECURITY,
					violationType: SecurityViolationType.POINTS_THRESHOLD_EXCEEDED,
					severity: EventSeverity.ERROR,
					points,
					ipAddress: ip,
					metadata: {
						threshold: thresholds.high,
						action: 'IP Blocked',
					},
				};

				const enrichedEvent = this.eventEnricher.enrichEvent(securityEvent);
				await this.logger.logSecurityViolation(ip, {
					type: enrichedEvent.violationType,
					points: enrichedEvent.points,
					details: enrichedEvent.metadata,
				});

				// Agregar a la lista negra si excede el umbral
				await this.addToList(
					ip,
					'blacklist',
					'Points threshold exceeded',
					new Date(Date.now() + 24 * 60 * 60 * 1000), // Bloquear por 24 horas
					points
				);
			}

			return { isBlocked, points };
		} catch (error) {
			this.logger.error(`Error checking IP status for ${ip}`, error);
			throw error;
		}
	}

	// Cambiado de private a public para uso en middleware
	async getPoints(ip: string): Promise<number> {
		const violations = await this.ipListModel
			.find({
				ip,
				isActive: true,
				timestamp: {
					$gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Últimas 24 horas
				},
			})
			.sort({ timestamp: -1 })
			.limit(10);

		return violations.reduce((total, violation) => total + (violation.points || 0), 0);
	}

	async isInList(ip: string, listType: 'whitelist' | 'blacklist'): Promise<boolean> {
		try {
			const count = await this.ipListModel.countDocuments({
				ip,
				listType,
				isActive: true,
				$or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
			});
			return count > 0;
		} catch (error) {
			this.logger.error(`Error checking if IP ${ip} is in ${listType}`, error);
			return false;
		}
	}

	async getList(listType: 'whitelist' | 'blacklist') {
		try {
			const items = await this.ipListModel
				.find({
					listType,
					isActive: true,
					$or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
				})
				.sort({ timestamp: -1 })
				.select({
					ip: 1,
					reason: 1,
					expiresAt: 1,
					points: 1,
					timestamp: 1,
					metadata: 1,
					createdAt: 1,
					updatedAt: 1,
				});

			return items.map((item) => ({
				ip: item.ip,
				reason: item.reason,
				expiresAt: item.expiresAt,
				points: item.points || 0,
				timestamp: item.timestamp || item.createdAt,
				metadata: item.metadata || {},
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			}));
		} catch (error) {
			this.logger.error(`Error getting ${listType} list`, error);
			throw error;
		}
	}

	getHelmetMiddleware() {
		return helmet({
			contentSecurityPolicy: {
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
					styleSrc: ["'self'", "'unsafe-inline'"],
					imgSrc: ["'self'", 'data:', 'https:'],
					connectSrc: ["'self'"],
					frameSrc: ["'self'"],
					fontSrc: ["'self'", 'https:', 'data:'],
				},
			},
			crossOriginEmbedderPolicy: false,
			crossOriginOpenerPolicy: false,
			crossOriginResourcePolicy: { policy: 'cross-origin' },
			xssFilter: true,
			hidePoweredBy: true,
			frameguard: false,
			noSniff: true,
		});
	}
}
