import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Holdings a los que un usuario tiene acceso: filas activas de `user_holdings` (el mismo criterio con el
 * que `POST /holdings/select` deja cambiar de holding; los super admin tienen una fila por holding).
 */
@Injectable()
export class UserHoldingsService {
	constructor(private readonly dataSource: DataSource) {}

	/** Ids de holding del usuario, con el seleccionado primero y luego el activo más antiguo. */
	async userHoldingIds(authId: string): Promise<string[]> {
		const rows = await this.dataSource.query<{ holding_id: string }[]>(
			`SELECT uh.holding_id
			 FROM user_holdings uh
			 JOIN users u ON u.id = uh.user_id
			 WHERE u.auth_id = $1 AND uh.is_active = true
			 ORDER BY uh.selected DESC, uh.created_at ASC`,
			[authId]
		);

		return rows.map((row) => row.holding_id);
	}
}
