import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { DbModule } from './db/db.module.js';
import { fileURLToPath } from 'node:url';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { APP_FILTER } from '@nestjs/core';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { CampusModule } from './campus/campus.module.js';

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
    CampusModule,
  ],
  providers: [
    // Registered here, not in main.ts, so every app built from AppModule (tests too) gets it
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule {}
