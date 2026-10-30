import { Controller, Get, HttpStatus, Inject, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DATABASE } from '../db/db.module.js';
import { sql, type Database } from '@pulse/db';

type Readiness =
  { status: 'ok'; checks: { database: 'up' } } | { status: 'error'; checks: { database: 'down' } };

// /health is liveness: the process runs. /health/ready is readiness: it can also reach PostgreSQL
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // A report, not an error: it sets 503 itself, since HttpErrorFilter would rewrite a thrown one
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<Readiness> {
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'ok', checks: { database: 'up' } };
    } catch (error) {
      // The reason goes to the log only: driver errors can name hosts, users and databases
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Database check failed: ${reason}`);
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'error', checks: { database: 'down' } };
    }
  }
}
