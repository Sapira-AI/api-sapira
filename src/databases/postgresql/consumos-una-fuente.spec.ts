import { BACKUP_SCHEMA } from './backups';
import { ConsumosDesdeQuantities1791600000000 } from './migrations/1791600000000-ConsumosDesdeQuantities';
import { PreciosMedidosSimpliRoute1791700000000 } from './migrations/1791700000000-PreciosMedidosSimpliRoute';

/**
 * Una sola fuente de consumos y precios por consumo de SimpliRoute (05-10-2026, Domi; `rebuild-devengo-comparacion.md` §9.5 D2-c).
 * Verifica el SQL de las dos migraciones de datos sin abrir conexión; la corrida contra la copia local está en el documento.
 */
const squash = (sql: string) => sql.replace(/\s+/g, ' ');
const runner = (answers: (sql: string) => unknown[] = () => []) => {
	const query = jest.fn(async (sql: string) => answers(sql));

	return { query, sql: () => query.mock.calls.map(([sql]) => squash(sql as string)) };
};

describe('migración 1791600000000 (quantities → consumption_entries)', () => {
	const Migration = ConsumosDesdeQuantities1791600000000;
	const source = squash(Migration.SOURCE_SQL);

	it('semántica de D2: cantidad del override (o la del ítem), monto fijado solo si el unitario difiere, solo monto → monto', () => {
		expect(source).toContain('GREATEST(0, COALESCE(q.quantity, ci.quantity, 0)) AS quantity');
		expect(source).toContain(
			'WHEN q.quantity IS NOT NULL AND q.unit_price IS NOT NULL THEN CASE WHEN q.unit_price IS NOT DISTINCT FROM ci.unit_price THEN NULL ELSE ROUND(q.unit_price * q.quantity, 2) END'
		);
		expect(source).toContain('WHEN q.quantity IS NULL AND q.unit_price IS NULL THEN q.amount');
	});

	it('período = el de la línea del ítem que empieza en ese mes (vigente y Por Emitir primero); sin línea, el mes calendario', () => {
		expect(source).toContain("date_trunc('month', ii.billing_period_start) = date_trunc('month', q.period)");
		expect(source).toContain("COALESCE(l.billing_period_start, date_trunc('month', q.period)::date) AS period_start");
		expect(source).toContain(
			"ORDER BY (i.is_active AND i.status IN ('Por Emitir', 'Emitida', 'Enviada', 'Pagada', 'Vencida')) DESC, (i.status = 'Por Emitir') DESC"
		);
		expect(source).toContain("AND COALESCE(i.document_type, '') NOT IN ('NC', 'ND')");
	});

	it('origen y fechas preservados sin etiqueta visible: dwh/manual por notes, idempotency_key quantities:<id>, created_by solo si es usuario', () => {
		expect(source).toContain("CASE WHEN q.notes LIKE 'DWH sapira_base%' THEN 'dwh' ELSE 'manual' END AS source");
		expect(source).toContain('(SELECT u.id FROM users u WHERE u.id = q.created_by) AS created_by');
		expect(source).toContain("AND NOT EXISTS (SELECT 1 FROM consumption_entries e WHERE e.idempotency_key = 'quantities:' || q.id::text)");
		expect(source).not.toContain("'legacy'");
	});

	it('up: respaldo en sapira_backups con RLS, entries revisión 1 sin pisar un período con consumo, y su fila de historial', async () => {
		const r = runner();

		await new Migration().up(r as never);
		const sql = r.sql();

		expect(Migration.BACKUP_TABLE).toBe(`${BACKUP_SCHEMA}.consumption_entries_1791600000000`);
		expect(sql[0]).toBe(`CREATE SCHEMA IF NOT EXISTS ${BACKUP_SCHEMA}`);
		expect(sql.some((text) => text.includes(`ALTER TABLE ${Migration.BACKUP_TABLE} ENABLE ROW LEVEL SECURITY`))).toBe(true);
		const insert = sql.find((text) => text.includes('INSERT INTO consumption_entries'))!;

		expect(insert).toContain('ON CONFLICT (contract_item_id, period_start) DO NOTHING');
		expect(insert).toContain(`INSERT INTO ${Migration.BACKUP_TABLE} (quantity_id, entry_id, contract_item_id, period_start)`);
		expect(insert).toContain("'quantities:' || quantity_id::text, 1, NULL");
		const revisions = sql.find((text) => text.includes('INSERT INTO consumption_entry_revisions'))!;

		expect(revisions).toContain('WHERE NOT EXISTS (SELECT 1 FROM consumption_entry_revisions r WHERE r.entry_id = e.id AND r.revision = 1)');
		// No toca quantities (queda de solo lectura) ni la borra.
		expect(sql.some((text) => /(UPDATE|DELETE FROM|DROP TABLE) quantities/.test(text))).toBe(false);
	});

	it('down: borra solo las entries copiadas que siguen en revisión 1 y el respaldo si queda vacío', async () => {
		const r = runner((sql) => (sql.includes('to_regclass') ? [{ present: true }] : sql.includes('count(*)') ? [{ n: 0 }] : []));

		await new Migration().down(r as never);
		const sql = r.sql();

		expect(sql.some((text) => text.includes('DELETE FROM consumption_entries e USING') && text.includes('e.revision = 1'))).toBe(true);
		expect(sql.some((text) => text === `DROP TABLE ${Migration.BACKUP_TABLE}`)).toBe(true);
	});
});

describe('migración 1791700000000 (ítems variables de SimpliRoute → precio por consumo)', () => {
	const Migration = PreciosMedidosSimpliRoute1791700000000;
	const target = squash(Migration.TARGET_ITEMS_SQL);

	it('solo ítems variables de SimpliRoute sin precio, con unitario y cantidad > 0 (quedan fuera los espejos de baja negativos)', () => {
		expect(target).toContain(`WHERE c.holding_id = '${Migration.HOLDING_ID}' AND ci.item_type = 'Variable' AND ci.price_id IS NULL`);
		expect(target).toContain('AND COALESCE(ci.unit_price, 0) > 0 AND COALESCE(ci.quantity, 0) > 0');
	});

	it('unitario del período = mensual × meses de la frecuencia; con descuento en monto fijo, el neto (el motor omite ese descuento)', () => {
		expect(target).toContain(
			"WHEN ci.discount_type = 'Monto fijo' AND COALESCE(ci.discount_value, 0) > 0 AND ci.monthly_price IS NOT NULL THEN ci.monthly_price / ci.quantity"
		);
		expect(target).toContain(
			"CASE ci.billing_frequency WHEN 'Trimestral' THEN 3 WHEN 'Semestral' THEN 6 WHEN 'Anual' THEN 12 WHEN 'Bianual' THEN 24 ELSE 1 END"
		);
		expect(target).toContain('COALESCE(ci.currency, c.contract_currency) AS currency');
	});

	it('up: métricas por unidad (dwh), precio propio del contrato standard + metered v1 activo y vínculo, con respaldo', async () => {
		const r = runner((sql) => (sql.includes('FROM company_holdings') ? [{ present: 1 }] : []));

		await new Migration().up(r as never);
		const sql = r.sql();
		const metrics = sql.find((text) => text.includes('INSERT INTO billable_metrics'))!;
		const prices = sql.find((text) => text.includes('INSERT INTO prices'))!;

		expect(metrics).toContain("'sum', d.unit, 'dwh'");
		expect(metrics).toContain('ON CONFLICT (holding_id, code) DO NOTHING');
		expect(prices).toContain("'contract', product_id, contract_id");
		expect(prices).toContain("'standard', 'metered', metric_id, unit_amount, 0, 0, 'single', false, 'active', 1, now()");
		expect(prices).toContain('UPDATE contract_items ci SET price_id = s.price_id');
		expect(prices).toContain(`INSERT INTO ${Migration.ITEMS_BACKUP} (item_id, old_price_id, new_price_id)`);
		// No cambia montos.
		expect(sql.some((text) => /UPDATE contract_items[^;]*(monthly_price|final_price|unit_price) =/.test(text))).toBe(false);
		expect(Migration.METRICS.map(([code]) => code)).toEqual(['vehiculos', 'mensajes', 'rutas', 'visitas', 'bolsas', 'unidades']);
	});

	it('up sin el holding (local/QA): no escribe nada', async () => {
		const r = runner();

		await new Migration().up(r as never);
		expect(r.sql().some((text) => text.includes('INSERT INTO prices'))).toBe(false);
	});

	it('down: devuelve price_id solo donde sigue apuntando al precio creado y borra precios y métricas sin uso', async () => {
		const r = runner((sql) => (sql.includes('to_regclass') ? [{ present: true }] : sql.includes('count(*)') ? [{ n: 0 }] : []));

		await new Migration().down(r as never);
		const sql = r.sql();

		expect(sql).toContain(
			`UPDATE contract_items ci SET price_id = b.old_price_id FROM ${Migration.ITEMS_BACKUP} b WHERE ci.id = b.item_id AND ci.price_id = b.new_price_id`
		);
		expect(sql.some((text) => text.includes('DELETE FROM prices p USING'))).toBe(true);
		expect(sql.some((text) => text.includes('DELETE FROM billable_metrics bm USING'))).toBe(true);
	});
});
