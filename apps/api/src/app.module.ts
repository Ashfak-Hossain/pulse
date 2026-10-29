import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';

// Root module: imports one module per domain area
@Module({
  imports: [HealthModule],
})
export class AppModule {}
