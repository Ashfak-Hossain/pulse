import { Module } from '@nestjs/common';
import { FareController } from './fare.controller.js';
import { FareService } from './fare.service.js';

@Module({ controllers: [FareController], providers: [FareService] })
export class FareModule {}
