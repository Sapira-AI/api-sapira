import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Emisión simulada de DTE en QA (`DTE_SIMULATED=true`): crea `dte_simulations`, siguiendo su entity
 * (`entities/facturacion/dte-simulation.entity.ts`), donde api-sapira guarda los documentos que "emite" sin pasar por api-factura.
 * Documentación: `front-sapira/docs/integracion-sii/emision-desde-contratos.md` → «Emisión simulada (QA)».
 *
 * La usa solo la API: RLS activo **sin policies**, sin grants al Data API. En producción queda vacía. Escrita a mano.
 */
export class DteSimulations1792400000000 implements MigrationInterface {
	name = 'DteSimulations1792400000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "dte_simulations" ("id" text NOT NULL, "company_id" uuid NOT NULL, "tipo" integer NOT NULL, "folio" integer NOT NULL, "external_ref" text NOT NULL, "body" jsonb NOT NULL, "track_id" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "dte_simulations_company_tipo_folio_key" UNIQUE ("company_id", "tipo", "folio"), CONSTRAINT "dte_simulations_company_external_ref_key" UNIQUE ("company_id", "external_ref"), CONSTRAINT "dte_simulations_pkey" PRIMARY KEY ("id"))`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "dte_simulations" IS 'DTE simulados (DTE_SIMULATED, solo QA): cuerpo, folio y envío sin pasar por api-factura. Solo la API'; COMMENT ON COLUMN "dte_simulations"."id" IS 'sim_<uuid>: es el dte_id que queda en la factura'; COMMENT ON COLUMN "dte_simulations"."tipo" IS 'Tipo de DTE (33, 34, 56, 61, 110…)'; COMMENT ON COLUMN "dte_simulations"."folio" IS 'Folio simulado, correlativo por compañía y tipo'; COMMENT ON COLUMN "dte_simulations"."external_ref" IS 'Referencia externa (id de la factura); una reemisión archiva la anterior como <ref>:rechazado:<id>'; COMMENT ON COLUMN "dte_simulations"."body" IS 'Cuerpo DTE tal como se habría enviado a api-factura (Encabezado, Detalle, Referencia)'; COMMENT ON COLUMN "dte_simulations"."track_id" IS 'TrackId simulado (SIM-<folio>) al "enviar al SII"'`
		);
		await queryRunner.query(
			`ALTER TABLE "dte_simulations" ADD CONSTRAINT "dte_simulations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
		);
		await queryRunner.query(`ALTER TABLE "dte_simulations" ENABLE ROW LEVEL SECURITY`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE IF EXISTS "dte_simulations"`);
	}
}
