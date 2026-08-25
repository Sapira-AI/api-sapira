import 'dotenv/config';
import { DataSource } from 'typeorm';

import { createPostgreSqlCliOptions } from './typeorm-options';

/**
 * DataSource único para comandos TypeORM. No ejecutar synchronize desde el
 * CLI sin habilitar explícitamente las variables de seguridad.
 */
export default new DataSource(createPostgreSqlCliOptions(process.env));
