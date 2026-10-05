import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Presupuestos genéricos (`docs/v2-rediseno/budgets-forecast-real.md` → "Construido 02-10: esquema"; decisión de Domi 02-10). Reemplaza la
 * migración `1790750000000-CashInGoals` (jsonb en `invoice_collection_settings`, nunca aplicada en ningún ambiente): el modelo se crea **una**
 * vez y sirve para caja, facturación, bookings y MRR. Esquema **aditivo**: dos tablas nuevas, nada existente se toca.
 *
 * 1. `budgets` — cabecera por holding: `kind` (cash_in, billing, bookings, mrr, new_mrr, expansion_mrr, contraction_mrr, churn_mrr),
 *    escenario (base · optimistic · pessimistic), moneda (la de sistema del holding al guardar), granularidad (month · quarter · year), año
 *    fiscal (= año calendario) y estado (draft · active · archived). Un presupuesto vivo por (holding, kind, año, escenario): índice único
 *    parcial `uq_budgets_holding_kind_year_scenario` `WHERE status <> 'archived'` (archivar libera el lugar). Entity
 *    `entities/revenue/budget.entity.ts`.
 * 2. `budget_lines` — una fila por celda: `period_start` (primer día del mes, trimestre o año), dimensión (`total`, `company`, `seller`,
 *    `product`, `client` con `dimension_id`; `segment`, `market` con `dimension_key` texto) y `amount numeric(18,2) ≥ 0`. Celda única por
 *    índice de expresión `uq_budget_lines_cell` (COALESCE de id y clave: un UNIQUE normal no deduplica NULL); también es asset
 *    (`special-index/uq_budget_lines_cell.sql`). Entity `entities/revenue/budget-line.entity.ts`.
 *
 * RLS: TypeORM no lo modela; se activa aquí y las 4 policies por tabla son assets (`rls/tenant_isolation_*_budgets.sql`,
 * `rls/tenant_isolation_*_budget_lines.sql`), igual que los triggers de `updated_at` (`triggers/trg_budgets_updated_at.sql`,
 * `triggers/trg_budget_lines_updated_at.sql`).
 *
 * Orden de despliegue: 1) esta migración, 2) los assets (policies, triggers, índice), 3) el código (`BudgetsModule`, meta de cobranza vía
 * presupuesto `cash_in`). Commit antes de aplicar, `schema:status` + `schema:log` en QA antes de producción. **NO APLICADA** al 02-10.
 */
export class Budgets1790750000000 implements MigrationInterface {
	name = 'Budgets1790750000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// 1. budgets
		await queryRunner.query(
			`CREATE TABLE "budgets" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"holding_id" uuid NOT NULL,
				"kind" text NOT NULL,
				"name" text NOT NULL,
				"scenario" text NOT NULL DEFAULT 'base',
				"currency" text NOT NULL,
				"period_granularity" text NOT NULL DEFAULT 'month',
				"fiscal_year" smallint NOT NULL,
				"status" text NOT NULL DEFAULT 'active',
				"notes" text,
				"created_by" uuid,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "budgets_kind_check" CHECK ("kind" = ANY (ARRAY['cash_in'::text, 'billing'::text, 'bookings'::text, 'mrr'::text, 'new_mrr'::text, 'expansion_mrr'::text, 'contraction_mrr'::text, 'churn_mrr'::text])),
				CONSTRAINT "budgets_scenario_check" CHECK ("scenario" = ANY (ARRAY['base'::text, 'optimistic'::text, 'pessimistic'::text])),
				CONSTRAINT "budgets_period_granularity_check" CHECK ("period_granularity" = ANY (ARRAY['month'::text, 'quarter'::text, 'year'::text])),
				CONSTRAINT "budgets_status_check" CHECK ("status" = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])),
				CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "budgets" IS 'Presupuestos por holding (caja, facturación, bookings, MRR): cabecera por kind, año fiscal y escenario; las celdas en budget_lines (budgets-forecast-real.md)'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "budgets"."currency" IS 'Moneda de sistema del holding al guardar (los montos de las líneas van en esta moneda)'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "budgets"."fiscal_year" IS 'Año fiscal (= año calendario)'`);
		await queryRunner.query(
			`CREATE UNIQUE INDEX "uq_budgets_holding_kind_year_scenario" ON "budgets" ("holding_id", "kind", "fiscal_year", "scenario") WHERE "status" <> 'archived'`
		);
		await queryRunner.query(
			`ALTER TABLE "budgets" ADD CONSTRAINT "budgets_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY`);

		// 2. budget_lines
		await queryRunner.query(
			`CREATE TABLE "budget_lines" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"holding_id" uuid NOT NULL,
				"budget_id" uuid NOT NULL,
				"period_start" date NOT NULL,
				"dimension_type" text NOT NULL DEFAULT 'total',
				"dimension_id" uuid,
				"dimension_key" text,
				"amount" numeric(18,2) NOT NULL,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				"updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "budget_lines_dimension_type_check" CHECK ("dimension_type" = ANY (ARRAY['total'::text, 'company'::text, 'seller'::text, 'product'::text, 'segment'::text, 'market'::text, 'client'::text])),
				CONSTRAINT "budget_lines_dimension_check" CHECK (("dimension_type" = 'total' AND "dimension_id" IS NULL AND "dimension_key" IS NULL) OR ("dimension_type" = ANY (ARRAY['segment'::text, 'market'::text]) AND "dimension_id" IS NULL AND "dimension_key" IS NOT NULL) OR ("dimension_type" = ANY (ARRAY['company'::text, 'seller'::text, 'product'::text, 'client'::text]) AND "dimension_id" IS NOT NULL AND "dimension_key" IS NULL)),
				CONSTRAINT "budget_lines_amount_check" CHECK ("amount" >= 0),
				CONSTRAINT "budget_lines_period_start_check" CHECK (EXTRACT(DAY FROM "period_start") = 1),
				CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "budget_lines" IS 'Celdas de un presupuesto: período (primer día del mes, trimestre o año), dimensión y monto en la moneda del presupuesto'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "budget_lines"."dimension_id" IS 'company, seller, product, client: id de la entidad; NULL en total, segment y market'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "budget_lines"."dimension_key" IS 'segment, market: valor del cliente (clients.segment / clients.market)'`
		);
		await queryRunner.query(
			`CREATE UNIQUE INDEX "uq_budget_lines_cell" ON "budget_lines" ("budget_id", "period_start", "dimension_type", COALESCE("dimension_id", '00000000-0000-0000-0000-000000000000'::uuid), COALESCE("dimension_key", ''))`
		);
		await queryRunner.query(`CREATE INDEX "idx_budget_lines_budget" ON "budget_lines" ("budget_id")`);
		await queryRunner.query(`CREATE INDEX "idx_budget_lines_holding_period" ON "budget_lines" ("holding_id", "period_start")`);
		await queryRunner.query(
			`ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_holding_id_fkey" FOREIGN KEY ("holding_id") REFERENCES "company_holdings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "budget_lines" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// No se revierte con presupuestos cargados (se perderían): se informa y se detiene.
		const [counts] = (await queryRunner.query(
			`SELECT (SELECT COUNT(*)::int FROM "budgets") AS budgets, (SELECT COUNT(*)::int FROM "budget_lines") AS lines`
		)) as Array<{ budgets: number; lines: number }>;

		if (Number(counts?.budgets) || Number(counts?.lines)) {
			throw new Error(`No se revierte: hay ${counts.budgets} presupuestos y ${counts.lines} líneas. Expórtalos y bórralos antes.`);
		}
		await queryRunner.query(`DROP TABLE "budget_lines"`);
		await queryRunner.query(`DROP TABLE "budgets"`);
	}
}
