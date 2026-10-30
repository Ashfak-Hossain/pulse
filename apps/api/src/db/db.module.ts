import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertRestrictedRole, createDb, type Database } from '@pulse/db';
import type { Env } from '../config/env.js';

// Injection token for the shared Drizzle client
export const DATABASE = Symbol('DATABASE');

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      useFactory: async (config: ConfigService<Env, true>): Promise<Database> => {
        const db = createDb(config.get('DATABASE_URL', { infer: true }), {
          connectionTimeoutMillis: 2000,
          // Safety nets for a server that accepted the connection and then hung:
          // PostgreSQL cancels a statement after 5 s, and the client stops waiting after 5 s
          statement_timeout: 5000,
          query_timeout: 5000,
        });

        const logger = new Logger('Database');

        // An idle connection can break. Without a listener Node crashes the process.
        // Log the message only: the URL holds a password
        db.$client.on('error', (error) => logger.error(`Idle connection failed: ${error.message}`));

        try {
          await assertRestrictedRole(db);
        } catch (error) {
          // Closing can fail too;
          await db.$client.end().catch(() => undefined);
          throw error;
        }
        return db;
      },
    },
  ],
  exports: [DATABASE],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // Runs on Ctrl+C / SIGTERM: close every pooled connection
  async onApplicationShutdown(): Promise<void> {
    await this.db.$client.end();
  }
}
