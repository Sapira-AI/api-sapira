import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { MASTER_DATA_CATEGORIES } from './dtos/catalogs.dto';
import { plural, Row, toCount, withUniqueMessage } from './settings-common';

import type {
	CreateMasterDataDto,
	CreateNamedDto,
	CreateSellerDto,
	MasterDataCategory,
	UpdateMasterDataDto,
	UpdateNamedDto,
	UpdateSellerDto,
} from './dtos/catalogs.dto';

/**
 * Uso de un valor de datos maestros: las tablas guardan el **texto** (no hay FK), así que se cuenta por coincidencia exacta dentro del
 * holding. Cada consulta recibe `$1` = holding y `$2` = valores.
 */
const MASTER_DATA_USAGE: Record<MasterDataCategory, string[]> = {
	payment_terms: [`SELECT payment_terms AS value, count(*) AS n FROM quotes WHERE holding_id = $1 AND payment_terms = ANY($2::text[]) GROUP BY 1`],
	item_types: ['contract_items', 'quote_items', 'subscription_items'].map(
		(table) => `SELECT item_type AS value, count(*) AS n FROM ${table} WHERE holding_id = $1 AND item_type = ANY($2::text[]) GROUP BY 1`
	),
	units_of_measure: ['contract_items', 'quote_items', 'invoice_items', 'quantities'].map(
		(table) =>
			`SELECT unit_of_measure AS value, count(*) AS n FROM ${table} WHERE holding_id = $1 AND unit_of_measure = ANY($2::text[]) GROUP BY 1`
	),
};

const sellerDto = (row: Row) => ({
	id: String(row.id),
	name: String(row.name ?? ''),
	email: String(row.email ?? ''),
	phone: (row.phone as string | null) ?? null,
	is_active: row.is_active === true,
	created_at: row.created_at,
	in_use: toCount(row.in_use),
});

const churnReasonDto = (row: Row) => ({
	id: String(row.id),
	name: String(row.name ?? ''),
	is_active: row.is_active === true,
	created_at: row.created_at,
	updated_at: row.updated_at,
	in_use: toCount(row.in_use),
});

/**
 * Catálogos del Holding 360: vendedores, motivos de baja y datos maestros (solo condiciones de pago, tipos de ítem y unidades de medida;
 * el resto de categorías se retira tras el switch, spec §2). Borrar solo si no se usa; si se usa, desactivar (409 con la sugerencia).
 */
@Injectable()
export class SettingsCatalogsService {
	constructor(private readonly dataSource: DataSource) {}

	// ── Vendedores ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private readonly sellerSelect = `SELECT s.*, (SELECT count(*) FROM quotes q WHERE q.seller_id = s.id) AS in_use FROM sellers s`;

	async listSellers(holdingId: string) {
		const rows = (await this.dataSource.query(`${this.sellerSelect} WHERE s.holding_id = $1 ORDER BY lower(s.name)`, [holdingId])) as Row[];

		return rows.map(sellerDto);
	}

	private async findSeller(holdingId: string, id: string): Promise<Row> {
		const [row] = (await this.dataSource.query(`${this.sellerSelect} WHERE s.id = $1 AND s.holding_id = $2`, [id, holdingId])) as Row[];

		if (!row) throw new NotFoundException('Vendedor no encontrado');

		return row;
	}

	/** El correo es único por holding sin distinguir mayúsculas (la tabla no tiene constraint: se valida aquí). */
	private async assertSellerEmailFree(holdingId: string, email: string, excludeId: string | null) {
		const rows = (await this.dataSource.query(
			`SELECT 1 FROM sellers WHERE holding_id = $1 AND lower(email) = lower($2) AND id IS DISTINCT FROM $3::uuid LIMIT 1`,
			[holdingId, email, excludeId]
		)) as Row[];

		if (rows.length) throw new ConflictException('Ya existe un vendedor con ese correo');
	}

	async createSeller(holdingId: string, dto: CreateSellerDto) {
		await this.assertSellerEmailFree(holdingId, dto.email, null);
		const [row] = (await this.dataSource.query(
			`INSERT INTO sellers (holding_id, name, email, phone, is_active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
			[holdingId, dto.name, dto.email, dto.phone ?? null]
		)) as Row[];

		return sellerDto(await this.findSeller(holdingId, String(row.id)));
	}

	async updateSeller(holdingId: string, id: string, dto: UpdateSellerDto) {
		const current = await this.findSeller(holdingId, id);

		if (dto.email !== undefined) await this.assertSellerEmailFree(holdingId, dto.email, id);
		await this.dataSource.query(`UPDATE sellers SET name = $3, email = $4, phone = $5, is_active = $6 WHERE id = $1 AND holding_id = $2`, [
			id,
			holdingId,
			dto.name ?? current.name,
			dto.email ?? current.email,
			dto.phone === undefined ? (current.phone ?? null) : dto.phone,
			dto.is_active ?? current.is_active,
		]);

		return sellerDto(await this.findSeller(holdingId, id));
	}

	async deleteSeller(holdingId: string, id: string): Promise<void> {
		const seller = await this.findSeller(holdingId, id);
		const inUse = toCount(seller.in_use);

		if (inUse > 0) {
			throw new ConflictException(`Este vendedor está en ${plural(inUse, 'cotización', 'cotizaciones')}: desactívalo en vez de eliminarlo`);
		}
		await this.dataSource.query(`DELETE FROM sellers WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}

	// ── Motivos de baja ─────────────────────────────────────────────────────────────────────────────────────────────────────────

	private readonly churnSelect = `SELECT r.*, (SELECT count(*) FROM contracts c WHERE c.churn_reason_id = r.id) AS in_use FROM churn_reasons r`;

	async listChurnReasons(holdingId: string) {
		const rows = (await this.dataSource.query(`${this.churnSelect} WHERE r.holding_id = $1 ORDER BY lower(r.name)`, [holdingId])) as Row[];

		return rows.map(churnReasonDto);
	}

	private async findChurnReason(holdingId: string, id: string): Promise<Row> {
		const [row] = (await this.dataSource.query(`${this.churnSelect} WHERE r.id = $1 AND r.holding_id = $2`, [id, holdingId])) as Row[];

		if (!row) throw new NotFoundException('Motivo de baja no encontrado');

		return row;
	}

	async createChurnReason(holdingId: string, dto: CreateNamedDto) {
		const [row] = await withUniqueMessage(
			async () =>
				(await this.dataSource.query(`INSERT INTO churn_reasons (holding_id, name, is_active) VALUES ($1, $2, true) RETURNING id`, [
					holdingId,
					dto.name,
				])) as Row[],
			'Ya existe un motivo de baja con ese nombre'
		);

		return churnReasonDto(await this.findChurnReason(holdingId, String(row.id)));
	}

	async updateChurnReason(holdingId: string, id: string, dto: UpdateNamedDto) {
		const current = await this.findChurnReason(holdingId, id);

		await withUniqueMessage(
			() =>
				this.dataSource.query(`UPDATE churn_reasons SET name = $3, is_active = $4, updated_at = now() WHERE id = $1 AND holding_id = $2`, [
					id,
					holdingId,
					dto.name ?? current.name,
					dto.is_active ?? current.is_active,
				]),
			'Ya existe un motivo de baja con ese nombre'
		);

		return churnReasonDto(await this.findChurnReason(holdingId, id));
	}

	async deleteChurnReason(holdingId: string, id: string): Promise<void> {
		const reason = await this.findChurnReason(holdingId, id);
		const inUse = toCount(reason.in_use);

		if (inUse > 0) {
			throw new ConflictException(`Este motivo está en ${plural(inUse, 'contrato', 'contratos')}: desactívalo en vez de eliminarlo`);
		}
		await this.dataSource.query(`DELETE FROM churn_reasons WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}

	// ── Datos maestros ──────────────────────────────────────────────────────────────────────────────────────────────────────────

	assertCategory(category: string): MasterDataCategory {
		if (!(MASTER_DATA_CATEGORIES as readonly string[]).includes(category)) {
			throw new BadRequestException('Categoría no válida: solo payment_terms, item_types o units_of_measure');
		}

		return category as MasterDataCategory;
	}

	private async usageByValue(holdingId: string, category: MasterDataCategory, values: string[]): Promise<Map<string, number>> {
		const usage = new Map<string, number>();

		if (!values.length) return usage;
		for (const sql of MASTER_DATA_USAGE[category]) {
			for (const row of (await this.dataSource.query(sql, [holdingId, values])) as Row[]) {
				usage.set(String(row.value), (usage.get(String(row.value)) ?? 0) + toCount(row.n));
			}
		}

		return usage;
	}

	private masterDataDto(row: Row, usage: Map<string, number>) {
		return {
			id: String(row.id),
			category: String(row.category),
			value: String(row.value),
			is_active: row.is_active === true,
			created_at: row.created_at,
			updated_at: row.updated_at,
			in_use: usage.get(String(row.value)) ?? 0,
		};
	}

	async listMasterData(holdingId: string, rawCategory: string) {
		const category = this.assertCategory(rawCategory);
		const rows = (await this.dataSource.query(`SELECT * FROM master_data WHERE holding_id = $1 AND category = $2 ORDER BY lower(value)`, [
			holdingId,
			category,
		])) as Row[];
		const usage = await this.usageByValue(
			holdingId,
			category,
			rows.map((row) => String(row.value))
		);

		return rows.map((row) => this.masterDataDto(row, usage));
	}

	private async findMasterData(holdingId: string, category: MasterDataCategory, id: string) {
		const [row] = (await this.dataSource.query(`SELECT * FROM master_data WHERE id = $1 AND holding_id = $2 AND category = $3`, [
			id,
			holdingId,
			category,
		])) as Row[];

		if (!row) throw new NotFoundException('Valor no encontrado');

		return { row, usage: await this.usageByValue(holdingId, category, [String(row.value)]) };
	}

	async createMasterData(holdingId: string, rawCategory: string, dto: CreateMasterDataDto) {
		const category = this.assertCategory(rawCategory);
		const [row] = await withUniqueMessage(
			async () =>
				(await this.dataSource.query(
					`INSERT INTO master_data (holding_id, category, value, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
					[holdingId, category, dto.value]
				)) as Row[],
			'Ya existe ese valor en esta lista'
		);
		const found = await this.findMasterData(holdingId, category, String(row.id));

		return this.masterDataDto(found.row, found.usage);
	}

	async updateMasterData(holdingId: string, rawCategory: string, id: string, dto: UpdateMasterDataDto) {
		const category = this.assertCategory(rawCategory);
		const { row, usage } = await this.findMasterData(holdingId, category, id);
		const inUse = usage.get(String(row.value)) ?? 0;

		if (dto.value !== undefined && dto.value !== row.value && inUse > 0) {
			throw new ConflictException(
				`Este valor está en uso (${plural(inUse, 'registro', 'registros')}): no se puede renombrar; desactívalo y crea uno nuevo`
			);
		}
		await withUniqueMessage(
			() =>
				this.dataSource.query(`UPDATE master_data SET value = $3, is_active = $4, updated_at = now() WHERE id = $1 AND holding_id = $2`, [
					id,
					holdingId,
					dto.value ?? row.value,
					dto.is_active ?? row.is_active,
				]),
			'Ya existe ese valor en esta lista'
		);
		const found = await this.findMasterData(holdingId, category, id);

		return this.masterDataDto(found.row, found.usage);
	}

	async deleteMasterData(holdingId: string, rawCategory: string, id: string): Promise<void> {
		const category = this.assertCategory(rawCategory);
		const { row, usage } = await this.findMasterData(holdingId, category, id);
		const inUse = usage.get(String(row.value)) ?? 0;

		if (inUse > 0) {
			throw new ConflictException(`Este valor está en uso (${plural(inUse, 'registro', 'registros')}): desactívalo en vez de eliminarlo`);
		}
		await this.dataSource.query(`DELETE FROM master_data WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}
}
