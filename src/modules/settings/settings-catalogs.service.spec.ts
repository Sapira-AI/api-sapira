import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { fakeDb, Handler } from './fake-db.testing-spec';
import { SettingsCatalogsService } from './settings-catalogs.service';
import { SettingsCustomFieldsService } from './settings-custom-fields.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const ID = '55555555-5555-4555-8555-555555555555';
const unique = Object.assign(new Error('duplicate key'), { code: '23505' });

const catalogs = (handlers: Handler[] = []) => {
	const db = fakeDb(handlers);

	return { db, service: new SettingsCatalogsService(db as unknown as DataSource) };
};

describe('SettingsCatalogsService', () => {
	describe('vendedores', () => {
		it('correo repetido (sin distinguir mayúsculas) → 409', async () => {
			const { db, service } = catalogs([['lower(email) = lower($2)', () => [{ 1: 1 }]]]);

			await expect(service.createSeller(HOLDING, { name: 'Ana', email: 'ANA@x.cl' })).rejects.toThrow('Ya existe un vendedor con ese correo');
			expect(db.statements('INSERT INTO sellers')).toHaveLength(0);
		});

		it('borrar un vendedor con cotizaciones → 409 con sugerencia; sin uso se borra', async () => {
			const used = catalogs([['WHERE s.id = $1 AND s.holding_id = $2', () => [{ id: ID, name: 'Ana', in_use: '4' }]]]);

			await expect(used.service.deleteSeller(HOLDING, ID)).rejects.toThrow(
				'Este vendedor está en 4 cotizaciones: desactívalo en vez de eliminarlo'
			);
			const free = catalogs([['WHERE s.id = $1 AND s.holding_id = $2', () => [{ id: ID, name: 'Ana', in_use: '0' }]]]);

			await free.service.deleteSeller(HOLDING, ID);
			expect(free.db.statements('DELETE FROM sellers')[0].params).toEqual([ID, HOLDING]);
		});

		it('vendedor de otro holding → 404', async () => {
			const { service } = catalogs();

			await expect(service.updateSeller(HOLDING, ID, { is_active: false })).rejects.toBeInstanceOf(NotFoundException);
		});

		it('desactivar conserva el resto de los campos', async () => {
			const { db, service } = catalogs([
				['WHERE s.id = $1 AND s.holding_id = $2', () => [{ id: ID, name: 'Ana', email: 'a@x.cl', phone: null, is_active: true, in_use: 0 }]],
			]);

			await service.updateSeller(HOLDING, ID, { is_active: false });
			expect(db.statements('UPDATE sellers')[0].params).toEqual([ID, HOLDING, 'Ana', 'a@x.cl', null, false]);
		});
	});

	describe('motivos de baja', () => {
		it('nombre repetido → 409 (violación de unicidad traducida)', async () => {
			const { service } = catalogs([
				[
					'INSERT INTO churn_reasons',
					() => {
						throw unique;
					},
				],
			]);

			await expect(service.createChurnReason(HOLDING, { name: 'Precio' })).rejects.toThrow(
				new ConflictException('Ya existe un motivo de baja con ese nombre')
			);
		});

		it('motivo usado en contratos no se borra', async () => {
			const { service } = catalogs([['WHERE r.id = $1 AND r.holding_id = $2', () => [{ id: ID, name: 'Precio', in_use: 1 }]]]);

			await expect(service.deleteChurnReason(HOLDING, ID)).rejects.toThrow('Este motivo está en 1 contrato: desactívalo en vez de eliminarlo');
		});
	});

	describe('datos maestros', () => {
		it('condiciones de pago salió de Configuración (Domi 03-10); otra lista → 400', async () => {
			const { service } = catalogs();

			await expect(service.listMasterData(HOLDING, 'quote_types')).rejects.toBeInstanceOf(BadRequestException);
			await expect(service.listMasterData(HOLDING, 'payment_terms')).rejects.toThrow(
				'Lista no válida: tipos de ítem, unidades de medida, mercados, segmentos o industrias'
			);
		});

		it('mercados, segmentos e industrias (ronda 3): uso = clientes del holding con ese texto exacto', async () => {
			const { db, service } = catalogs([
				[
					'FROM master_data WHERE holding_id = $1 AND category = $2',
					() => [{ id: ID, category: 'industries', value: 'Retail', is_active: true }],
				],
				['FROM clients WHERE holding_id = $1 AND industry', () => [{ value: 'Retail', n: '4' }]],
			]);
			const [row] = await service.listMasterData(HOLDING, 'industries');

			expect(row).toMatchObject({ in_use: 4, usage: { clients: 4, contracts: 0 } });
			expect(db.statements('FROM clients WHERE holding_id = $1 AND industry = ANY')).toHaveLength(1);
			await expect(service.listMasterData(HOLDING, 'markets')).resolves.toBeDefined();
			await expect(service.listMasterData(HOLDING, 'segments')).resolves.toBeDefined();
		});

		it('el uso de unidades suma las seis tablas por texto exacto dentro del holding, con desglose', async () => {
			const { db, service } = catalogs([
				[
					'FROM master_data WHERE holding_id = $1 AND category = $2',
					() => [{ id: ID, category: 'units_of_measure', value: 'Usuarios', is_active: true }],
				],
				['FROM contract_items WHERE holding_id = $1 AND unit_of_measure', () => [{ value: 'Usuarios', n: '3' }]],
				['FROM quantities WHERE holding_id = $1 AND unit_of_measure', () => [{ value: 'Usuarios', n: '2' }]],
				['FROM invoice_items_legacy WHERE holding_id = $1 AND unit_of_measure', () => [{ value: 'Usuarios', n: '4' }]],
				['FROM sapira_quantity_imports WHERE holding_id = $1 AND unit_of_measure', () => [{ value: 'Usuarios', n: '1' }]],
			]);
			const [row] = await service.listMasterData(HOLDING, 'units_of_measure');

			expect(row.in_use).toBe(10);
			expect(row.usage).toEqual({ contracts: 3, quotes: 0, subscriptions: 0, invoices: 4, quantities: 3, clients: 0 });
			expect(db.statements('unit_of_measure = ANY($2::text[])').map((call) => call.sql.match(/FROM (\w+)/)?.[1])).toEqual([
				'contract_items',
				'quote_items',
				'invoice_items',
				'invoice_items_legacy',
				'quantities',
				'sapira_quantity_imports',
			]);
		});

		it('el uso de tipos de ítem cuenta contratos, cotizaciones, suscripciones y facturas antiguas', async () => {
			const { db, service } = catalogs([
				[
					'FROM master_data WHERE holding_id = $1 AND category = $2',
					() => [{ id: ID, category: 'item_types', value: 'Licencia', is_active: true }],
				],
				['FROM subscription_items WHERE holding_id = $1 AND item_type', () => [{ value: 'Licencia', n: '2' }]],
				['FROM invoice_items_legacy WHERE holding_id = $1 AND item_type', () => [{ value: 'Licencia', n: '5' }]],
			]);
			const [row] = await service.listMasterData(HOLDING, 'item_types');

			expect(row).toMatchObject({ in_use: 7, usage: { subscriptions: 2, invoices: 5, contracts: 0, quotes: 0, quantities: 0 } });
			expect(db.statements('item_type = ANY($2::text[])')).toHaveLength(4);
		});

		it('renombrar o borrar un valor en uso → 409; desactivarlo sí', async () => {
			const handlers: Handler[] = [
				[
					'WHERE id = $1 AND holding_id = $2 AND category = $3',
					() => [{ id: ID, category: 'units_of_measure', value: 'Horas', is_active: true }],
				],
				['FROM contract_items WHERE holding_id = $1 AND unit_of_measure', () => [{ value: 'Horas', n: 12 }]],
			];
			const { db, service } = catalogs(handlers);

			await expect(service.updateMasterData(HOLDING, 'units_of_measure', ID, { value: 'Hora' })).rejects.toThrow(
				'Este valor está en uso (12 registros): no se puede renombrar; desactívalo y crea uno nuevo'
			);
			await expect(service.deleteMasterData(HOLDING, 'units_of_measure', ID)).rejects.toThrow('desactívalo en vez de eliminarlo');
			await service.updateMasterData(HOLDING, 'units_of_measure', ID, { is_active: false });
			expect(db.statements('UPDATE master_data')[0].params).toEqual([ID, HOLDING, 'Horas', false]);
		});
	});
});

describe('SettingsCustomFieldsService', () => {
	const build = (handlers: Handler[] = []) => {
		const db = fakeDb(handlers);

		return { db, service: new SettingsCustomFieldsService(db as unknown as DataSource) };
	};
	const field = {
		id: ID,
		entity_type: 'contract_item',
		field_name: 'fecha_de_corte',
		field_label: 'Fecha de corte',
		field_type: 'text',
		is_required: false,
		is_active: true,
		display_order: 0,
	};

	it('cuenta valores en la tabla de la entidad, dentro del holding', async () => {
		const { db, service } = build([['FROM contract_items WHERE holding_id = $1', () => [{ n: '102' }]]]);

		await expect(service.valuesCount(HOLDING, 'contract_item', 'fecha_de_corte')).resolves.toBe(102);
		expect(db.calls[0].params).toEqual([HOLDING, 'fecha_de_corte']);
	});

	it('la lista cuenta agrupado: una consulta por entidad (no una por campo); quote no consulta', async () => {
		const { db, service } = build([
			[
				'FROM custom_field_definitions WHERE holding_id = $1',
				() => [
					field,
					{ ...field, id: 'f2', field_name: 'centro_costo' },
					{ ...field, id: 'f3', entity_type: 'quote', field_name: 'probabilidad' },
				],
			],
			['JOIN contract_items t', () => [{ name: 'fecha_de_corte', n: '7' }]],
		]);
		const fields = await service.list(HOLDING);

		expect(fields.map((item) => [item.field_name, item.values_count])).toEqual([
			['fecha_de_corte', 7],
			['centro_costo', 0],
			['probabilidad', 0],
		]);
		const grouped = db.statements('FROM unnest($2::text[]) AS f(name)');

		expect(grouped).toHaveLength(1);
		expect(grouped[0].params).toEqual([HOLDING, ['fecha_de_corte', 'centro_costo']]);
	});

	it('quote no tiene columna custom_fields: 0 sin consultar', async () => {
		const { db, service } = build();

		await expect(service.valuesCount(HOLDING, 'quote', 'probabilidad')).resolves.toBe(0);
		expect(db.calls).toHaveLength(0);
	});

	it('con valores: no se borra ni cambia nombre/tipo, pero sí la etiqueta', async () => {
		const { db, service } = build([
			['FROM custom_field_definitions WHERE id = $1', () => [field]],
			['FROM contract_items WHERE holding_id', () => [{ n: 5 }]],
			['UPDATE custom_field_definitions', () => [{ ...field, field_label: 'Corte' }]],
		]);

		await expect(service.remove(HOLDING, ID)).rejects.toThrow('Este campo tiene valores en 5 registros: desactívalo en vez de eliminarlo');
		await expect(service.update(HOLDING, ID, { field_type: 'number' })).rejects.toThrow('no se puede cambiar su nombre interno ni su tipo');
		await expect(service.update(HOLDING, ID, { field_label: 'Corte' })).resolves.toMatchObject({ field_label: 'Corte', values_count: 5 });
		expect(db.statements('DELETE FROM custom_field_definitions')).toHaveLength(0);
	});

	it('nombre interno repetido → 409', async () => {
		const { service } = build([
			[
				'INSERT INTO custom_field_definitions',
				() => {
					throw unique;
				},
			],
		]);

		await expect(
			service.create(HOLDING, { entity_type: 'contract', field_name: 'tipo', field_label: 'Tipo', field_type: 'text' }, null)
		).rejects.toThrow('Ya existe un campo con ese nombre interno para esta entidad');
	});
});
