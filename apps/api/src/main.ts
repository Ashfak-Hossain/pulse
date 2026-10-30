import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

const app = await NestFactory.create(AppModule);
// Runs onModuleDestroy / onApplicationShutdown on Ctrl+C or SIGTERM: closes the database pool now,
// and the Kafka and RabbitMQ clients later
app.enableShutdownHooks();

// Already validated by ConfigModule, so PORT is a number and HOST has its default
const config: ConfigService<Env, true> = app.get(ConfigService);
const host = config.get('HOST', { infer: true });
const port = config.get('PORT', { infer: true });

await app.listen(port, host);
new Logger('Bootstrap').log(`API listening on http://${host}:${port}`);
