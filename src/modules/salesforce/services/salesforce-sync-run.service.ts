import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { SalesforceSyncRun, SalesforceSyncRunStatus, SalesforceSyncRunType } from '../entities/salesforce-sync-run.entity';
import { SalesforceSyncRunItem } from '../entities/salesforce-sync-run-item.entity';

const ACTIVE_STATUSES: SalesforceSyncRunStatus[] = ['queued', 'running', 'cancellation_requested'];

@Injectable()
export class SalesforceSyncRunService {
	constructor(
		@InjectRepository(SalesforceSyncRun)
		private readonly runRepository: Repository<SalesforceSyncRun>,
		@InjectRepository(SalesforceSyncRunItem)
		private readonly itemRepository: Repository<SalesforceSyncRunItem>,
		@InjectDataSource()
		private readonly dataSource: DataSource
	) {}

	async createRun(
		holdingId: string,
		type: SalesforceSyncRunType,
		opportunityIds: string[],
		options: { dateFrom?: string; dateTo?: string } = {}
	): Promise<SalesforceSyncRun> {
		const ids = [...new Set(opportunityIds.filter(Boolean))];
		if (!ids.length) {
			throw new ConflictException('Debes seleccionar al menos una oportunidad para iniciar la ejecución');
		}

		const activeRun = await this.runRepository.findOne({
			where: { holding_id: holdingId, type, status: In(ACTIVE_STATUSES) },
			order: { created_at: 'DESC' },
		});
		if (activeRun) {
			throw new ConflictException('Ya existe una ejecución de este tipo en curso para el holding');
		}

		return this.dataSource.transaction(async (manager) => {
			const run = await manager.save(
				manager.create(SalesforceSyncRun, {
					holding_id: holdingId,
					type,
					date_from: options.dateFrom || null,
					date_to: options.dateTo || null,
					total_items: ids.length,
				})
			);
			await manager.insert(
				SalesforceSyncRunItem,
				ids.map((salesforceOpportunityId) => ({
					run_id: run.id,
					salesforce_opportunity_id: salesforceOpportunityId,
				}))
			);
			return run;
		});
	}

	async getRun(holdingId: string, runId: string): Promise<SalesforceSyncRun> {
		const run = await this.runRepository.findOne({ where: { id: runId, holding_id: holdingId } });
		if (!run) {
			throw new NotFoundException('Ejecución Salesforce no encontrada');
		}
		return run;
	}

	async requestCancellation(holdingId: string, runId: string): Promise<SalesforceSyncRun> {
		const run = await this.getRun(holdingId, runId);
		if (!ACTIVE_STATUSES.includes(run.status)) {
			return run;
		}

		await this.runRepository.update(run.id, { status: 'cancellation_requested' });
		await this.itemRepository.update({ run_id: run.id, status: In(['pending', 'processing']) }, { status: 'cancelled' });
		return this.getRun(holdingId, runId);
	}

	async getRunnableRuns(limit = 5): Promise<SalesforceSyncRun[]> {
		return this.runRepository.find({
			where: { status: In(['queued', 'running', 'cancellation_requested']) },
			order: { created_at: 'ASC' },
			take: limit,
		});
	}

	async acquireRunLock(runId: string, leaseMs = 30 * 60 * 1000): Promise<boolean> {
		const now = new Date();
		const lockedUntil = new Date(now.getTime() + leaseMs);
		const result = await this.runRepository
			.createQueryBuilder()
			.update(SalesforceSyncRun)
			.set({ locked_until: lockedUntil })
			.where('id = :runId', { runId })
			.andWhere('status IN (:...statuses)', { statuses: ['queued', 'running', 'cancellation_requested'] })
			.andWhere('(locked_until IS NULL OR locked_until < :now)', { now })
			.execute();
		return (result.affected || 0) === 1;
	}

	async releaseRunLock(runId: string): Promise<void> {
		await this.runRepository.update(runId, { locked_until: null });
	}

	async recoverExpiredClaims(timeoutMs = 10 * 60 * 1000): Promise<void> {
		const claimedBefore = new Date(Date.now() - timeoutMs);
		await this.itemRepository
			.createQueryBuilder()
			.update(SalesforceSyncRunItem)
			.set({ status: 'pending', claimed_at: null })
			.where('status = :status', { status: 'processing' })
			.andWhere('claimed_at < :claimedBefore', { claimedBefore })
			.execute();
	}

	async claimPendingItems(runId: string, limit: number): Promise<SalesforceSyncRunItem[]> {
		return this.dataSource.transaction(async (manager) => {
			const run = await manager.findOne(SalesforceSyncRun, {
				where: { id: runId, status: In(['queued', 'running']) },
				lock: { mode: 'pessimistic_write' },
			});
			if (!run) {
				return [];
			}

			if (run.status === 'queued') {
				await manager.update(SalesforceSyncRun, run.id, { status: 'running', started_at: new Date() });
			}

			const items = await manager
				.createQueryBuilder(SalesforceSyncRunItem, 'item')
				.setLock('pessimistic_write')
				.setOnLocked('skip_locked')
				.where('item.run_id = :runId', { runId })
				.andWhere('item.status = :status', { status: 'pending' })
				.orderBy('item.created_at', 'ASC')
				.take(limit)
				.getMany();
			if (!items.length) {
				return [];
			}

			await manager
				.createQueryBuilder()
				.update(SalesforceSyncRunItem)
				.set({ status: 'processing', claimed_at: new Date(), attempts: () => 'attempts + 1' })
				.whereInIds(items.map((item) => item.id))
				.execute();

			return items.map((item) => ({ ...item, status: 'processing', attempts: item.attempts + 1 }));
		});
	}

	async completeItem(item: SalesforceSyncRunItem): Promise<void> {
		await this.itemRepository.update(item.id, { status: 'completed', processed_at: new Date(), error_message: null });
		await this.runRepository
			.createQueryBuilder()
			.update(SalesforceSyncRun)
			.set({ completed_items: () => 'completed_items + 1' })
			.where('id = :runId', { runId: item.run_id })
			.execute();
	}

	async failItem(item: SalesforceSyncRunItem, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		await this.itemRepository.update(item.id, { status: 'error', error_message: message, processed_at: new Date() });
		await this.runRepository
			.createQueryBuilder()
			.update(SalesforceSyncRun)
			.set({ failed_items: () => 'failed_items + 1' })
			.where('id = :runId', { runId: item.run_id })
			.execute();
	}

	async finishRunIfDone(runId: string): Promise<void> {
		const run = await this.runRepository.findOne({ where: { id: runId } });
		if (!run || !ACTIVE_STATUSES.includes(run.status)) {
			return;
		}

		const counts = await this.itemRepository
			.createQueryBuilder('item')
			.select('item.status', 'status')
			.addSelect('COUNT(1)', 'count')
			.where('item.run_id = :runId', { runId })
			.groupBy('item.status')
			.getRawMany<{ status: string; count: string }>();
		const countByStatus = new Map(counts.map((row) => [row.status, Number(row.count)]));
		const pending = (countByStatus.get('pending') || 0) + (countByStatus.get('processing') || 0);
		if (pending) {
			return;
		}

		const completed = countByStatus.get('completed') || 0;
		const failed = countByStatus.get('error') || 0;
		await this.runRepository.update(runId, {
			status: run.status === 'cancellation_requested' ? 'cancelled' : completed === 0 && failed > 0 ? 'failed' : 'completed',
			completed_items: completed,
			failed_items: failed,
			finished_at: new Date(),
		});
	}
}
