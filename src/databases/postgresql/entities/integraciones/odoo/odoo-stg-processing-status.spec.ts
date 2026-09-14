import { getMetadataArgsStorage } from 'typeorm';

import { OdooInvoiceLinesStg } from '@/databases/postgresql/entities/integraciones/odoo/odoo-invoice-lines-stg.entity';
import { OdooInvoicesStg } from '@/databases/postgresql/entities/integraciones/odoo/odoo-invoices-stg.entity';
import { OdooPartnersStg } from '@/databases/postgresql/entities/integraciones/odoo/odoo-partners-stg.entity';

/**
 * Guarda la invariante que las tablas de staging de Odoo violaban en producción: el default
 * declarado para `processing_status` tiene que ser uno de los valores que admite su propio CHECK.
 *
 * `odoo_invoices_stg` y `odoo_invoice_lines_stg` tenían `DEFAULT 'pending'` contra un CHECK
 * `create | update | processed | error`, así que cualquier INSERT que omitiera la columna producía
 * una fila rechazada con 23514. En producción no se manifestaba porque el trigger BEFORE INSERT de
 * cada tabla pisa la columna antes de que el CHECK la mire, pero sí rompe en cualquier escenario sin
 * trigger (replicación lógica, `--disable-triggers`, esquema creado desde las entities sin assets).
 *
 * Lee la metadata cruda de los decoradores: no abre conexión ni construye relaciones.
 */
describe('Staging de Odoo · default de processing_status vs su CHECK', () => {
	const storage = getMetadataArgsStorage();

	const entidades = [
		{ tabla: 'odoo_invoices_stg', target: OdooInvoicesStg, defaultEsperado: 'create' },
		{ tabla: 'odoo_invoice_lines_stg', target: OdooInvoiceLinesStg, defaultEsperado: 'create' },
		{ tabla: 'odoo_partners_stg', target: OdooPartnersStg, defaultEsperado: 'processed' },
	];

	/** Extrae los literales de un CHECK con forma `col = ANY (ARRAY['a'::text, 'b'::text])`. */
	const valoresAdmitidos = (expresion: string): string[] => [...expresion.matchAll(/'([^']+)'::text/g)].map(([, valor]) => valor);

	const checkDe = (target: object, columna: string) =>
		storage.checks.find((check) => check.target === target && check.expression.includes(columna));

	const defaultDe = (target: object, columna: string) =>
		storage.columns.find((column) => column.target === target && column.propertyName === columna)?.options.default;

	describe.each(entidades)('$tabla', ({ target, defaultEsperado }) => {
		it('declara un CHECK sobre processing_status', () => {
			expect(checkDe(target, 'processing_status')).toBeDefined();
		});

		it('tiene un default que su propio CHECK admite', () => {
			expect(valoresAdmitidos(checkDe(target, 'processing_status').expression)).toContain(defaultDe(target, 'processing_status'));
		});

		it('mantiene el default acordado con negocio', () => {
			expect(defaultDe(target, 'processing_status')).toBe(defaultEsperado);
		});

		it("no reintroduce 'pending', que ningún consumidor procesa", () => {
			expect(valoresAdmitidos(checkDe(target, 'processing_status').expression)).not.toContain('pending');
			expect(defaultDe(target, 'processing_status')).not.toBe('pending');
		});
	});
});
