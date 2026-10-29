import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT || 3000);

const app = await NestFactory.create(AppModule);
// Runs onModuleDestroy hooks on Ctrl+C / SIGTERM, so later Kafka and RabbitMQ clients close cleanly
app.enableShutdownHooks();
await app.listen(port, host);
new Logger('Bootstrap').log(`API listening on http://${host}:${port}`);
