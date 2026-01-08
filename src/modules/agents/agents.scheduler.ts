import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

import { AgentsService } from './agents.service';

@Injectable()
export class AgentsScheduler {
	private readonly logger = new Logger(AgentsScheduler.name);

	constructor(
		private readonly agentsService: AgentsService,
		private readonly dataSource: DataSource
	) {}

	@Cron(CronExpression.EVERY_MINUTE)
	async checkScheduledAgents() {
		this.logger.debug('Checking for scheduled agents to execute...');

		try {
			const agents = await this.dataSource.query(
				`
				SELECT 
					id, 
					type, 
					schedule, 
					holding_id,
					auto_execute,
					require_approval
				FROM ai_agents 
				WHERE is_enabled = true 
					AND auto_execute = true
					AND schedule IS NOT NULL
			`
			);

			if (!agents || agents.length === 0) {
				this.logger.debug('No scheduled agents found');
				return;
			}

			for (const agent of agents) {
				try {
					if (this.shouldExecuteNow(agent.schedule)) {
						this.logger.log(`Executing scheduled agent: ${agent.type} (${agent.id})`);

						await this.agentsService.runAgent(agent.id, agent.holding_id, 'execute');

						this.logger.log(`Successfully executed agent: ${agent.type} (${agent.id})`);
					}
				} catch (error) {
					this.logger.error(`Error executing agent ${agent.id}:`, error);
				}
			}
		} catch (error) {
			this.logger.error('Error in checkScheduledAgents:', error);
		}
	}

	private shouldExecuteNow(cronExpression: string): boolean {
		try {
			const now = new Date();
			const currentMinute = now.getMinutes();
			const currentHour = now.getHours();
			const currentDay = now.getDate();
			const currentMonth = now.getMonth() + 1;
			const currentDayOfWeek = now.getDay();

			const parts = cronExpression.trim().split(/\s+/);
			if (parts.length !== 5) {
				this.logger.warn(`Invalid cron expression: ${cronExpression}`);
				return false;
			}

			const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

			if (!this.matchesCronPart(minute, currentMinute)) return false;
			if (!this.matchesCronPart(hour, currentHour)) return false;
			if (!this.matchesCronPart(dayOfMonth, currentDay)) return false;
			if (!this.matchesCronPart(month, currentMonth)) return false;
			if (!this.matchesCronPart(dayOfWeek, currentDayOfWeek)) return false;

			return true;
		} catch (error) {
			this.logger.error(`Error parsing cron expression ${cronExpression}:`, error);
			return false;
		}
	}

	private matchesCronPart(cronPart: string, currentValue: number): boolean {
		if (cronPart === '*') return true;

		if (cronPart.includes(',')) {
			const values = cronPart.split(',').map((v) => parseInt(v.trim()));
			return values.includes(currentValue);
		}

		if (cronPart.includes('-')) {
			const [start, end] = cronPart.split('-').map((v) => parseInt(v.trim()));
			return currentValue >= start && currentValue <= end;
		}

		if (cronPart.includes('/')) {
			const [base, step] = cronPart.split('/');
			const stepValue = parseInt(step);
			if (base === '*') {
				return currentValue % stepValue === 0;
			}
			const baseValue = parseInt(base);
			return currentValue >= baseValue && (currentValue - baseValue) % stepValue === 0;
		}

		const value = parseInt(cronPart);
		return value === currentValue;
	}
}
