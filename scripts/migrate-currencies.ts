import * as fs from 'fs';
import * as path from 'path';

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

// Cargar variables de entorno
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
	console.error('❌ Error: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY deben estar definidas en .env');
	process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function runMigration() {
	try {
		console.log('🚀 Iniciando migración de tabla currencies...\n');

		// Leer el archivo SQL de migración
		const migrationPath = path.join(__dirname, '../../sapira-ai/supabase/migrations/20260501193300_create_currencies_table.sql');
		const sqlContent = fs.readFileSync(migrationPath, 'utf-8');

		console.log('📄 Archivo de migración cargado:', migrationPath);
		console.log('📝 Contenido SQL:\n');
		console.log(sqlContent);
		console.log('\n');

		// Ejecutar la migración usando el cliente de Supabase
		// Nota: Supabase no tiene un método directo para ejecutar SQL raw desde el cliente JS
		// Por lo que usaremos la función RPC o ejecutaremos directamente en PostgreSQL

		console.log('⚠️  IMPORTANTE: Este script muestra el SQL que debe ejecutarse.');
		console.log('⚠️  Para ejecutar la migración, usa uno de estos métodos:\n');
		console.log('1. Supabase CLI:');
		console.log('   cd sapira-ai');
		console.log('   npx supabase db push\n');
		console.log('2. Supabase Dashboard:');
		console.log('   - Ve a SQL Editor');
		console.log('   - Copia y pega el contenido del archivo de migración');
		console.log('   - Ejecuta el SQL\n');
		console.log('3. Conexión directa a PostgreSQL:');
		console.log('   psql -h <host> -U postgres -d postgres -f sapira-ai/supabase/migrations/20260501193300_create_currencies_table.sql\n');

		// Verificar si la tabla ya existe
		const { error } = await supabase.from('currencies').select('code').limit(1);

		if (error && error.code === '42P01') {
			console.log('❌ La tabla currencies aún no existe. Ejecuta la migración usando uno de los métodos anteriores.');
		} else if (error) {
			console.log('❌ Error verificando la tabla:', error.message);
		} else {
			console.log('✅ La tabla currencies ya existe!');
			console.log('📊 Verificando datos...\n');

			// Obtener todas las monedas
			const { data: currencies, error: fetchError } = await supabase.from('currencies').select('*').order('code');

			if (fetchError) {
				console.log('❌ Error obteniendo monedas:', fetchError.message);
			} else {
				console.log(`✅ Se encontraron ${currencies?.length || 0} monedas:\n`);
				console.table(currencies);
			}
		}
	} catch (error) {
		console.error('❌ Error ejecutando migración:', error);
		process.exit(1);
	}
}

runMigration();
