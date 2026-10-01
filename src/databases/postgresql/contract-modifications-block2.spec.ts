import * as fs from 'fs';
import * as path from 'path';

import { DataSource, EntityMetadata, QueryRunner } from 'typeorm';

import { HoldingSettings } from './entities/base-tenancy/holding-settings.entity';
import { ContractItemPause } from './entities/contratos/contract-item-pause.entity';
import { ContractItem } from './entities/contratos/contract-item.entity';
import { ContractScheduledChange } from './entities/contratos/contract-scheduled-change.entity';
import * as espejoExistentes from './entities/espejo.existing';
import * as espejoTodos from './entities/espejo.index';
import { RevenueScheduleMonthly } from './entities/revenue/revenue-schedule-monthly.entity';
import { ContractModificationsBlock21790710000000 } from './migrations/1790710000000-ContractModificationsBlock2';

/**
 * Bloque Modificaciones B2 (`docs/v2-rediseno/spec-modificaciones-contrato-v2.md` §9.4 #1–#5): migración escrita a mano, entities, policies
 * y triggers como assets, y el cambio mínimo del asset del devengo (§9.3.9). Sin conexión: texto de la migración y metadata en memoria.
 */
const migrationSql = async (direction: 'up' | 'down', counts = { rsm: 0, pacts: 0, pauses: 0, own_cycle: 0 }) => {
	const statements: string[] = [];
	const runner = {
		query: jest.fn(async (sql: string) => {
			statements.push(sql);

			return sql.includes('COUNT(*)') ? [counts] : [];
		}),
	} as unknown as QueryRunner;

	await new ContractModificationsBlock21790710000000()[direction](runner);

	return statements;
};

describe('migración 1790710000000-ContractModificationsBlock2', () => {
	it('up: crea contract_scheduled_changes con sus CHECK, FKs e índices y activa RLS', async () => {
		const sql = (await migrationSql('up')).join('\n');

		expect(sql).toContain('CREATE TABLE "contract_scheduled_changes"');
		expect(sql).toContain(`"origin" jsonb NOT NULL DEFAULT '{"type":"manual"}'`);
		expect(sql).toContain(`"value" numeric(18,6) NOT NULL`);
		for (const constraint of [
			'contract_scheduled_changes_trigger_check',
			'contract_scheduled_changes_kind_check',
			'contract_scheduled_changes_rounding_check',
			'contract_scheduled_changes_status_check',
			'contract_scheduled_changes_interval_months_check',
			'contract_scheduled_changes_on_date_check',
			'contract_scheduled_changes_every_n_months_check',
			'contract_scheduled_changes_index_check',
			'contract_scheduled_changes_holding_id_fkey',
			'contract_scheduled_changes_contract_id_fkey',
			'contract_scheduled_changes_contract_item_id_fkey',
			'contract_scheduled_changes_parent_id_fkey',
			'contract_scheduled_changes_applied_event_id_fkey',
		])
			expect(sql).toContain(`"${constraint}"`);
		expect(sql).toContain(`CHECK ("trigger" <> 'every_n_months' OR ("anchor_date" IS NOT NULL AND "interval_months" IS NOT NULL))`);
		expect(sql).toContain(`REFERENCES "contract_lifecycle_events"("id") ON DELETE SET NULL`);
		expect(sql).toContain(`ON "contract_scheduled_changes" ("holding_id", "status", "next_effective_date")`);
		expect(sql).toContain('ALTER TABLE "contract_scheduled_changes" ENABLE ROW LEVEL SECURITY');
	});

	it('up: contract_item_pauses, billing_anchor_day 1–31, aviso de renovación 1–180 (default 30) y momentum PAUSE/RESUME', async () => {
		const sql = (await migrationSql('up')).join('\n');

		expect(sql).toContain('CREATE TABLE "contract_item_pauses"');
		expect(sql).toContain(`CONSTRAINT "contract_item_pauses_dates_check" CHECK ("pause_end" IS NULL OR "pause_end" >= "pause_start")`);
		expect(sql).toContain('ALTER TABLE "contract_item_pauses" ENABLE ROW LEVEL SECURITY');
		expect(sql).toContain('ALTER TABLE "contract_items" ADD "billing_anchor_day" smallint');
		expect(sql).toContain(
			`"contract_items_billing_anchor_day_check" CHECK ("billing_anchor_day" IS NULL OR ("billing_anchor_day" >= 1 AND "billing_anchor_day" <= 31))`
		);
		expect(sql).toContain('ALTER TABLE "holding_settings" ADD "auto_renewal_notice_days" smallint NOT NULL DEFAULT 30');
		expect(sql).toContain(`CHECK ("auto_renewal_notice_days" >= 1 AND "auto_renewal_notice_days" <= 180)`);
		expect(sql).toContain(`'PENDING_RENEWAL'::text, 'PAUSE'::text, 'RESUME'::text]`);
		// Sin cambios en contracts ni en invoices (§9.4).
		expect(sql).not.toMatch(/ALTER TABLE "(contracts|invoices)"/);
	});

	it('down: se niega con datos que el esquema viejo no admite; sin ellos revierte todo en orden inverso', async () => {
		await expect(migrationSql('down', { rsm: 0, pacts: 2, pauses: 0, own_cycle: 0 })).rejects.toThrow('2 pactos');
		const sql = await migrationSql('down');

		expect(sql.slice(1).map((statement) => statement.split(' ').slice(0, 4).join(' '))).toEqual([
			'ALTER TABLE "revenue_schedule_monthly" DROP',
			'ALTER TABLE "revenue_schedule_monthly" ADD',
			'ALTER TABLE "holding_settings" DROP',
			'ALTER TABLE "holding_settings" DROP',
			'ALTER TABLE "contract_items" DROP',
			'ALTER TABLE "contract_items" DROP',
			'DROP TABLE "contract_item_pauses"',
			'DROP TABLE "contract_scheduled_changes"',
		]);
		expect(sql[2]).not.toContain('PAUSE');
	});
});

describe('entities del bloque B2', () => {
	const dataSource = new DataSource({ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] });
	const meta = (target: unknown) => dataSource.entityMetadatas.find((entry) => entry.target === target) as EntityMetadata;

	beforeAll(async () => {
		await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
	});

	it('ContractScheduledChange declara columnas, CHECK, índices y FKs con los nombres de la migración', () => {
		const metadata = meta(ContractScheduledChange);

		expect(dataSource.isInitialized).toBe(false);
		expect(Object.fromEntries(metadata.columns.map((column) => [column.databaseName, column.isNullable]))).toEqual({
			id: false,
			holding_id: false,
			contract_id: false,
			contract_item_id: true,
			group_key: true,
			parent_id: true,
			trigger: false,
			effective_date: true,
			anchor_date: true,
			interval_months: true,
			next_effective_date: true,
			kind: false,
			value: false,
			index_code: true,
			index_base_date: true,
			index_base_value: true,
			index_lag_months: true,
			rounding: true,
			status: false,
			status_reason: true,
			status_changed_by: true,
			applied_event_id: true,
			applied_at: true,
			applied_value: true,
			origin: false,
			notes: true,
			created_by: true,
			created_at: false,
			updated_at: false,
		});
		expect(metadata.checks.map((check) => check.name).sort()).toEqual(
			[
				'contract_scheduled_changes_every_n_months_check',
				'contract_scheduled_changes_index_check',
				'contract_scheduled_changes_interval_months_check',
				'contract_scheduled_changes_kind_check',
				'contract_scheduled_changes_on_date_check',
				'contract_scheduled_changes_rounding_check',
				'contract_scheduled_changes_status_check',
				'contract_scheduled_changes_trigger_check',
			].sort()
		);
		expect(Object.fromEntries(metadata.foreignKeys.map((fk) => [fk.name, [fk.referencedEntityMetadata.tableName, fk.onDelete]]))).toEqual({
			contract_scheduled_changes_holding_id_fkey: ['company_holdings', 'CASCADE'],
			contract_scheduled_changes_contract_id_fkey: ['contracts', 'CASCADE'],
			contract_scheduled_changes_contract_item_id_fkey: ['contract_items', 'CASCADE'],
			contract_scheduled_changes_parent_id_fkey: ['contract_scheduled_changes', 'CASCADE'],
			contract_scheduled_changes_applied_event_id_fkey: ['contract_lifecycle_events', 'SET NULL'],
		});
		expect(metadata.indices.map((index) => index.name).sort()).toEqual([
			'idx_contract_scheduled_changes_contract_status',
			'idx_contract_scheduled_changes_holding_status_next',
			'idx_contract_scheduled_changes_item',
		]);
	});

	it('ContractItemPause, contract_items.billing_anchor_day, holding_settings.auto_renewal_notice_days y momentum PAUSE/RESUME', () => {
		const pause = meta(ContractItemPause);

		expect(pause.tableName).toBe('contract_item_pauses');
		expect(pause.columns.find((column) => column.databaseName === 'pause_end')?.isNullable).toBe(true);
		expect(pause.columns.find((column) => column.databaseName === 'contract_item_id')?.isNullable).toBe(false);
		expect(pause.checks.map((check) => check.name).sort()).toEqual(['contract_item_pauses_dates_check', 'contract_item_pauses_status_check']);
		const item = meta(ContractItem);

		expect(item.columns.find((column) => column.databaseName === 'billing_anchor_day')).toMatchObject({ isNullable: true, type: 'smallint' });
		expect(item.checks.map((check) => check.name)).toContain('contract_items_billing_anchor_day_check');
		const settings = meta(HoldingSettings).columns.find((column) => column.databaseName === 'auto_renewal_notice_days');

		expect(settings).toMatchObject({ isNullable: false, default: 30 });
		expect(meta(RevenueScheduleMonthly).checks.find((check) => check.name === 'revenue_schedule_monthly_momentum_check')?.expression).toContain(
			`'PAUSE'::text, 'RESUME'::text`
		);
	});
});

describe('assets del bloque B2', () => {
	const read = (...segments: string[]) => fs.readFileSync(path.join(__dirname, ...segments), 'utf8');

	it('4 policies por tabla nueva, como las de contract_fx_period_rates, y el trigger de updated_at', () => {
		for (const table of ['contract_scheduled_changes', 'contract_item_pauses']) {
			for (const [operation, clause] of [
				['select', 'USING'],
				['insert', 'WITH CHECK'],
				['update', 'USING'],
				['delete', 'USING'],
			]) {
				const sql = read('rls', `tenant_isolation_${operation}_${table}.sql`);

				expect(sql).toContain(`CREATE POLICY "tenant_isolation_${operation}_${table}"`);
				expect(sql).toContain(`FOR ${operation.toUpperCase()}`);
				expect(sql).toContain(`${clause} (((holding_id = get_current_user_holding_id()) AND (contract_id IN ( SELECT contracts.id`);
			}
			expect(read('triggers', `trg_${table}_updated_at.sql`)).toContain(
				`CREATE TRIGGER trg_${table}_updated_at BEFORE UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`
			);
		}
	});

	it('revenue_schedule_rebuild_contract_ccy (§9.3.9): día de ciclo por ítem y sin prorrateo del primer mes en ciclo propio', () => {
		const sql = read('functions', 'revenue_schedule_rebuild_contract_ccy.sql');

		expect(sql).toContain('SELECT c.id, c.holding_id, c.company_id, c.contract_currency, c.billing_anchor_day,');
		expect(sql).toContain(
			'SELECT COALESCE(v_contract.billing_anchor_day, EXTRACT(DAY FROM MIN(ci.start_date))::int) INTO v_contract_billing_day'
		);
		expect(sql).toContain('AND ci.billing_anchor_day IS NULL;');
		expect(sql).toContain('v_billing_day := COALESCE(v_item.billing_anchor_day, v_contract_billing_day);');
		expect(sql).toContain(
			"AND v_item.billing_anchor_day IS NULL\n           AND COALESCE(v_item.categoria, '') IN ('UPSELL', 'CROSS-SELL', 'DOWNSELL') THEN"
		);
		// Formato del generador: la función cierra con `$function$;` y su COMMENT.
		expect(sql).toMatch(/END;\n\$function\$;\n\nCOMMENT ON FUNCTION/);
	});
	it('revenue_schedule_rebuild_contract_ccy (§9.3.3, B2-5): pausas → devengo por días, MRR 0, CMRR con fin conocido y momentum PAUSE/RESUME', () => {
		const sql = read('functions', 'revenue_schedule_rebuild_contract_ccy.sql');

		// Devengo: días pausados del mes sobre los días activos del ítem (mes completo pausado → 0).
		expect(sql).toContain('FROM contract_item_pauses p');
		expect(sql).toContain("WHERE p.contract_item_id = v_item.id AND p.status <> 'cancelled'");
		expect(sql).toContain('v_active_days := (LEAST(v_eom_of_cur, v_item.end_date) - GREATEST(v_cur, v_item.start_date)) + 1;');
		expect(sql).toContain(
			'v_recognized_period := ROUND(v_recognized_period * GREATEST(v_active_days - v_paused_days, 0)::numeric / v_active_days, 2);'
		);
		// MRR 0 con fin de mes pausado; CMRR solo se apaga si la pausa es abierta.
		expect(sql).toContain(
			'IF v_paused_eom AND v_is_recurring THEN\n        v_mrr_contracted := 0;\n        IF v_paused_open_eom THEN v_cmrr := 0; END IF;'
		);
		// Momentum explícito (NULL = lo asigna trg_assign_momentum, como hasta hoy).
		expect(sql).toContain("v_momentum := 'PAUSE';");
		expect(sql).toContain("v_momentum := 'RESUME';");
		expect(sql).toContain("AND DATE_TRUNC('month', p.pause_end + 1)::date = v_cur");
		expect(sql).toContain('        momentum\n      ) VALUES (');
		expect(sql).toContain('v_momentum  -- B2-5: PAUSE / RESUME; NULL = trg_assign_momentum');
		// B2-3 intacto.
		expect(sql).toContain('v_billing_day := COALESCE(v_item.billing_anchor_day, v_contract_billing_day);');
		expect(sql).toMatch(/END;\n\$function\$;\n\nCOMMENT ON FUNCTION/);
	});
});
