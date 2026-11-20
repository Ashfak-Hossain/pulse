import { Module } from '@nestjs/common';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';
import { TrustedContactService } from './trusted-contact.service.js';
import { VehicleService } from './vehicle.service.js';

@Module({
  controllers: [MeController],
  providers: [MeService, VehicleService, TrustedContactService],
})
export class MeModule {}
