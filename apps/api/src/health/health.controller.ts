import { Controller, Get } from '@nestjs/common';

// Liveness only: answers while the process runs. The database check comes with @pulse/db
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
