import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE } from '../db/db.module.js';
import { sql, type Database } from '@pulse/db';

type Ready = { status: 'ok'; checks: { database: 'up' } };

// /health is liveness: the process runs. /health/ready is readiness: it can also reach PostgreSQL
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<Ready> {
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'ok', checks: { database: 'up' } };
    } catch (error) {
      // The reason goes to the log only: driver errors can name hosts, users and databases
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Database check failed: ${reason}`);
      throw new ServiceUnavailableException({ status: 'error', checks: { database: 'down' } });
    }
  }
}
