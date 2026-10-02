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
		it('solo payment_terms, item_types y units_of_measure', async () => {
			const { service } = catalogs();

			await expect(service.listMasterData(HOLDING, 'markets')).rejects.toBeInstanceOf(BadRequestException);
		});

		it('el uso de unidades suma las cuatro tablas por texto exacto dentro del holding', async () => {
			const { db, service } = catalogs([
				[
					'FROM master_data WHERE holding_id = $1 AND category = $2',
					() => [{ id: ID, category: 'units_of_measure', value: 'Usuarios', is_active: true }],
				],
				['FROM contract_items WHERE holding_id = $1 AND unit_of_measure', () => [{ value: 'Usuarios', n: '3' }]],
				['FROM quantities WHERE holding_id = $1 AND unit_of_measure', () => [{ value: 'Usuarios', n: '2' }]],
			]);
			const [row] = await service.listMasterData(HOLDING, 'units_of_measure');

			expect(row.in_use).toBe(5);
			expect(db.statements('unit_of_measure = ANY($2::text[])')).toHaveLength(4);
		});

		it('renombrar o borrar un valor en uso → 409; desactivarlo sí', async () => {
			const handlers: Handler[] = [
				[
					'WHERE id = $1 AND holding_id = $2 AND category = $3',
					() => [{ id: ID, category: 'payment_terms', value: '30 días', is_active: true }],
				],
				['FROM quotes WHERE holding_id = $1 AND payment_terms', () => [{ value: '30 días', n: 12 }]],
			];
			const { db, service } = catalogs(handlers);

			await expect(service.updateMasterData(HOLDING, 'payment_terms', ID, { value: '30 dias' })).rejects.toThrow(
				'Este valor está en uso (12 registros): no se puede renombrar; desactívalo y crea uno nuevo'
			);
			await expect(service.deleteMasterData(HOLDING, 'payment_terms', ID)).rejects.toThrow('desactívalo en vez de eliminarlo');
			await service.updateMasterData(HOLDING, 'payment_terms', ID, { is_active: false });
			expect(db.statements('UPDATE master_data')[0].params).toEqual([ID, HOLDING, '30 días', false]);
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
