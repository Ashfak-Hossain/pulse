import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { DbModule } from './db/db.module.js';
import { fileURLToPath } from 'node:url';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { CampusModule } from './campus/campus.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CourseModule } from './course/course.module.js';
import { FareModule } from './fare/fare.module.js';
import { AuthModule } from './auth/auth.module.js';
import { PlacesModule } from './places/places.module.js';
import { OriginGuard } from './common/origin.guard.js';

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
    CourseModule,
    CatalogModule,
    FareModule,
    AuthModule,
    PlacesModule,
  ],
  providers: [
    // Registered here, not in main.ts, so every app built from AppModule (tests too) gets it
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    // Runs before AuthModule's AuthGuard, so a cross-site request gets 403 without a session lookup
    { provide: APP_GUARD, useClass: OriginGuard },
  ],
})
export class AppModule {}
