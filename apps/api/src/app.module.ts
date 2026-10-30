import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { DbModule } from './db/db.module.js';
import { fileURLToPath } from 'node:url';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';

// The repo-root .env
const rootEnvFile = fileURLToPath(new URL('../../../.env', import.meta.url));

// Root module: imports one module per domain area
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: rootEnvFile,
      validate: validateEnv,
    }),
    HealthModule,
    DbModule,
  ],
})
export class AppModule {}
