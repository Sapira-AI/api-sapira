import * as fs from 'fs';
import * as path from 'path';

import { QueryRunner } from 'typeorm';

import { UnificaTriggerGeneracionFacturas1790660000000 } from './migrations/1790660000000-UnificaTriggerGeneracionFacturas';

/**
 * Costura `sapira.writer = 'api'` (30-09-2026, `docs/v2-rediseno/activacion-costura-triggers.md` § Construido, regla
 * `docs/reglas-desarrollo/logica-en-api-triggers.md`): cada trigger legacy de la lista empieza con el guard; los invariantes
 * no lo tienen; el generador legacy queda unificado; U9 en el RSM; REVOKE de `generate_missing_invoices_for_contract`.
 * Verifica los assets como texto, sin abrir conexión.
 */
const dir = __dirname;
const read = (folder: string, name: string) => fs.readFileSync(path.join(dir, folder, name), 'utf8');
const fn = (name: string) => read('functions', `${name}.sql`);

/** Triggers BEFORE (INSERT/UPDATE): el guard devuelve NEW para no cancelar la fila. */
const BEFORE = [
	'standardize_invoice_items',
	'auto_populate_invoice_item_fields',
	'sync_invoice_item_contract_id',
	'set_contract_item_end_date',
	'inherit_auto_renew_from_quote_item',
	'trg_set_contract_item_categoria',
	'auto_calculate_pricing_fields',
	'set_booking_date_on_activate',
	'set_contract_company_currency',
	'auto_populate_invoice_tax_rate',
	'auto_populate_invoice_fx_to_system',
	'invoices_fill_terms_from_contract',
	'assign_invoice_group_id',
	'validate_fx_confirmation_before_firmado',
];
/** Triggers AFTER: el valor de retorno se ignora; el guard devuelve NULL. */
const AFTER = [
	'trigger_generate_invoices_on_status_change',
	'trigger_generate_invoices_on_contract_signed',
	'update_contract_term',
	'trigger_revenue_schedule_on_contract_activation',
	'auto_calculate_contract_fx',
	'trg_audit_contract_changes',
	'trigger_rsm_on_contract_item_change',
	'trigger_rsm_on_invoice_change',
	'trigger_rsm_on_quantity_change',
	// Facturación v2 (spec-facturacion-v2 §8): pagos registrados por la API no pasan por recalc_invoice_status.
	'after_invoice_payment_change',
];
/** Invariantes: corren igual para la API y el front viejo (no leen la marca). */
const INVARIANTS = ['trg_period_guard_contracts', 'validate_contract_currency_consistency', 'validate_contract_item_currency_consistency'];

/** Primera sentencia del cuerpo: lo que sigue al primer `BEGIN` de línea después de `AS $function$`, sin comentarios. */
const firstStatement = (sql: string) => {
	const body = sql.slice(sql.indexOf('AS $function$'));
	const begin = body.search(/^BEGIN[ \t]*$/m);

	return body
		.slice(begin + 'BEGIN'.length)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('--'))
		.slice(0, 3)
		.join(' ');
};
const guard = (value: 'NEW' | 'NULL') => new RegExp(`^IF current_setting\\('sapira\\.writer', true\\) = 'api' THEN RETURN ${value};`);

describe('costura sapira.writer: guard como primera sentencia', () => {
	it.each(BEFORE)('%s (BEFORE) sale con RETURN NEW si la API escribe', (name) => {
		expect(firstStatement(fn(name))).toMatch(guard('NEW'));
	});

	it.each(AFTER)('%s (AFTER) sale con RETURN NULL si la API escribe', (name) => {
		expect(firstStatement(fn(name))).toMatch(guard('NULL'));
	});

	it('el guard aparece una sola vez por función y solo en las de la lista (más ninguna otra del corpus)', () => {
		const readers = fs
			.readdirSync(path.join(dir, 'functions'))
			.filter((file) => fn(file.replace(/\.sql$/, '')).includes(`current_setting('sapira.writer'`))
			.map((file) => file.replace(/\.sql$/, ''))
			.sort();

		expect(readers).toEqual([...BEFORE, ...AFTER].sort());
		for (const name of readers) expect(fn(name).match(/current_setting\('sapira\.writer'/g)).toHaveLength(1);
	});

	it.each(INVARIANTS)('invariante %s intacto: no lee la marca', (name) => {
		expect(fn(name)).not.toContain('sapira.writer');
	});

	it('los validadores de moneda conservan su única salida (sapira.skip_currency_validation) y el RAISE', () => {
		for (const name of ['validate_contract_currency_consistency', 'validate_contract_item_currency_consistency']) {
			const sql = fn(name);

			expect(sql).toContain(`current_setting('sapira.skip_currency_validation', true) = 'on'`);
			expect(sql).toContain('RAISE EXCEPTION');
		}
		expect(fn('trg_period_guard_contracts')).toContain('public.is_period_guard_bypassed()');
	});
});

describe('validadores de moneda con multimoneda (spec-multimoneda-contrato §3 #2–#4)', () => {
	it('ítem: distinto de la moneda del contrato solo con requires_multicurrency_billing (flag off → mismo error de hoy)', () => {
		const sql = fn('validate_contract_item_currency_consistency');

		expect(sql).toContain('SELECT contract_currency, COALESCE(requires_multicurrency_billing, false) INTO v_contract_currency, v_multicurrency');
		expect(sql).toContain('NEW.currency IS DISTINCT FROM v_contract_currency AND NOT v_multicurrency THEN');
		expect(sql).toContain(`RAISE EXCEPTION 'Contract item currency (%) must match contract currency (%)'`);
		// Nunca no-op: sin flag el RAISE sigue y el bypass del borrador es la única otra salida.
		expect(sql.match(/RETURN NEW;/g)).toHaveLength(2);
	});

	it('contrato: con flag permite ítems en otra moneda; sin flag exige todos iguales; true → false con ítems en otra moneda → RAISE', () => {
		const sql = fn('validate_contract_currency_consistency');
		const flagOn = sql.indexOf('IF COALESCE(NEW.requires_multicurrency_billing, false) THEN RETURN NEW; END IF;');
		const skip = sql.indexOf(`current_setting('sapira.skip_currency_validation', true) = 'on'`);

		expect(skip).toBeGreaterThan(-1);
		expect(flagOn).toBeGreaterThan(skip);
		expect(sql).toContain(`IF TG_OP = 'UPDATE' THEN\n      IF COALESCE(OLD.requires_multicurrency_billing, false) THEN`);
		expect(sql).toContain(`RAISE EXCEPTION 'No se puede desactivar multimoneda: hay ítems en otra moneda'`);
		expect(sql).toContain(`RAISE EXCEPTION 'Contract currency (%) must match all contract items currency'`);
	});

	it('change_contract_currency (legacy) rechaza contratos multimoneda o con ítems en otra moneda antes de pisar ítems', () => {
		const sql = fn('change_contract_currency');
		const guard = sql.indexOf(`RAISE EXCEPTION 'Contrato multimoneda: cambia monedas desde Sapira v2'`);

		expect(sql).toContain('IF COALESCE(v_contract.requires_multicurrency_billing, false)');
		expect(sql).toContain('WHERE contract_id = p_contract_id AND currency IS DISTINCT FROM v_contract.contract_currency) THEN');
		expect(guard).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(sql.indexOf(`PERFORM set_config('sapira.skip_currency_validation', 'on', true);`));
	});
});

describe('generador legacy de facturas unificado (decisión #9)', () => {
	it('queda un solo trigger: unified_generate_invoices_on_contract_signed (INSERT o cambio de estado)', () => {
		const triggers = fs.readdirSync(path.join(dir, 'triggers'));

		expect(triggers).toContain('unified_generate_invoices_on_contract_signed.sql');
		expect(triggers).not.toContain('generate_invoices_on_contract_active.sql');
		expect(read('triggers', 'unified_generate_invoices_on_contract_signed.sql')).toContain(
			'CREATE TRIGGER unified_generate_invoices_on_contract_signed AFTER INSERT OR UPDATE OF status ON public.contracts FOR EACH ROW EXECUTE FUNCTION trigger_generate_invoices_on_contract_signed();'
		);
		const referencing = triggers.filter((file) => read('triggers', file).includes('trigger_generate_invoices_on_status_change'));

		expect(referencing).toEqual([]);
	});

	it('la función unificada conserva la rama INSERT/Firmado/Activo del front viejo y es SECURITY DEFINER', () => {
		const sql = fn('trigger_generate_invoices_on_contract_signed');

		expect(sql).toMatch(/LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path TO 'public'/);
		expect(sql).toContain(`IF NEW.status IN ('Firmado', 'Activo') AND (OLD.status IS NULL OR OLD.status != NEW.status) THEN`);
		expect(sql).toContain('FROM public.generate_missing_invoices_for_contract(NEW.id)');
		expect(sql).toContain('WHERE contract_id = NEW.id');
	});

	it('la migración elimina el trigger duplicado y el down() lo recrea tal cual', async () => {
		const query = jest.fn(async () => undefined);
		const runner = { query } as unknown as QueryRunner;
		const migration = new UnificaTriggerGeneracionFacturas1790660000000();

		await migration.up(runner);
		expect(query).toHaveBeenLastCalledWith('DROP TRIGGER IF EXISTS generate_invoices_on_contract_active ON public.contracts');
		await migration.down(runner);
		expect(query).toHaveBeenLastCalledWith(
			'CREATE TRIGGER generate_invoices_on_contract_active AFTER UPDATE OF status ON public.contracts FOR EACH ROW EXECUTE FUNCTION trigger_generate_invoices_on_status_change()'
		);
	});
});

describe('U9 en el RSM: holding del registro, no el de la sesión', () => {
	it.each([
		['trigger_rsm_on_contract_item_change', `CASE WHEN TG_OP = 'DELETE' THEN OLD.holding_id ELSE NEW.holding_id END`],
		['trigger_rsm_on_invoice_change', `CASE WHEN TG_OP = 'DELETE' THEN OLD.holding_id ELSE NEW.holding_id END`],
		['trigger_rsm_on_quantity_change', 'NEW.holding_id'],
	])('%s lee financial_settings del holding de la fila', (name, expression) => {
		const sql = fn(name);

		expect(sql).not.toContain('get_current_user_holding_id()');
		expect(sql).toContain(`FROM financial_settings\n  WHERE holding_id = ${expression}\n  LIMIT 1;`);
	});
});

describe('grants/030: generate_missing_invoices_for_contract fuera del alcance de rpc', () => {
	it('REVOKE a PUBLIC, anon y authenticated; EXECUTE solo a service_role; aviso de no aplicar sin OK', () => {
		const sql = read('grants', '030-generate-missing-invoices-execute.sql');

		expect(sql).toContain('REVOKE ALL ON FUNCTION public.generate_missing_invoices_for_contract(uuid) FROM PUBLIC, anon, authenticated;');
		expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.generate_missing_invoices_for_contract(uuid) TO service_role;');
		expect(sql).toContain('NO APLICAR SIN OK DE DOMI');
	});
});
