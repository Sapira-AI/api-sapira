import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { fakeDb, Handler } from '@/modules/settings/fake-db.testing-spec';

import { ProductsService } from './products.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '99999999-0000-4000-8000-000000000001';

const row = (extra: Record<string, unknown> = {}) => ({
	id: PRODUCT,
	product_code: 'TMS-01',
	name: 'TMS',
	is_recurring: true,
	status: 'active',
	contracts: 0,
	quotes: 0,
	prices: 0,
	invoice_items: 0,
	subscription_items: 0,
	odoo: false,
	stripe: false,
	salesforce: 0,
	salesforce_rows: 0,
	...extra,
});
const build = (product: Record<string, unknown> | null, handlers: Handler[] = []) => {
	const db = fakeDb([...handlers, ['WHERE p.id = $1 AND p.holding_id = $2', (params) => (product && params[1] === HOLDING ? [product] : [])]]);

	return { db, service: new ProductsService(db as unknown as DataSource) };
};

describe('ProductsService', () => {
	it('lista con uso y mapeos, filtrando por estado y búsqueda dentro del holding', async () => {
		const { db, service } = build(null, [
			['FROM products p WHERE p.holding_id = $1', () => [row({ contracts: '12', quotes: 30, prices: 2, odoo: true, salesforce: 3 })]],
		]);
		const [product] = await service.list(HOLDING, { status: 'archived', search: 'tms' });

		expect(product).toMatchObject({ usage: { contracts: 12, quotes: 30, prices: 2 }, mappings: { odoo: true, salesforce: 3, stripe: false } });
		expect(db.calls[0].params).toEqual([HOLDING, 'archived', '%tms%']);
	});

	it('código repetido (sin mayúsculas ni espacios) → 409', async () => {
		const { db, service } = build(null, [['lower(btrim(product_code)) = lower(btrim($2))', () => [{ 1: 1 }]]]);

		await expect(service.create(HOLDING, { product_code: ' tms-01 ', name: 'TMS' })).rejects.toThrow(
			new ConflictException('Ya existe un producto con el código  tms-01 ')
		);
		expect(db.statements('INSERT INTO products')).toHaveLength(0);
	});

	it('crear nace activo y recurrente por defecto, sin precio', async () => {
		const { db, service } = build(row(), [['INSERT INTO products', () => [{ id: PRODUCT }]]]);

		await service.create(HOLDING, { product_code: 'TMS-01', name: 'TMS' });
		const [insert] = db.statements('INSERT INTO products');

		expect(insert.sql).not.toContain('default_price');
		expect(insert.params).toEqual([HOLDING, 'TMS-01', 'TMS', true]);
	});

	it('cambiar si es recurrente con uso → 409', async () => {
		const { service } = build(row({ contracts: 1 }));

		await expect(service.update(HOLDING, PRODUCT, { is_recurring: false })).rejects.toThrow(
			'El producto está en uso: no se puede cambiar si es recurrente'
		);
	});

	it('archivar y reactivar', async () => {
		const { db, service } = build(row());

		await service.setStatus(HOLDING, PRODUCT, 'archived');
		await service.setStatus(HOLDING, PRODUCT, 'active');
		expect(db.statements('UPDATE products SET status').map((call) => call.params[2])).toEqual(['archived', 'active']);
	});

	it('eliminar: en uso → 409 con detalle; mapeado → 409; nunca usado → borra', async () => {
		await expect(build(row({ contracts: 12, quotes: 30 })).service.remove(HOLDING, PRODUCT)).rejects.toThrow(
			'El producto está en uso (12 contratos, 30 cotizaciones): archívalo en vez de eliminarlo'
		);
		await expect(build(row({ odoo: true, salesforce_rows: 1 })).service.remove(HOLDING, PRODUCT)).rejects.toThrow(
			'El producto está vinculado con Odoo/Salesforce: quita el vínculo en Integraciones o archívalo'
		);
		const { db, service } = build(row());

		await service.remove(HOLDING, PRODUCT);
		expect(db.statements('DELETE FROM products')[0].params).toEqual([PRODUCT, HOLDING]);
	});

	it('producto de otro holding → 404', async () => {
		await expect(build(null).service.get(HOLDING, PRODUCT)).rejects.toBeInstanceOf(NotFoundException);
	});
});
