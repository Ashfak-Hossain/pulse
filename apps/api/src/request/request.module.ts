import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { RequestController } from './request.controller.js';
import { RequestService } from './request.service.js';

// Ride requests. For now only reading free text into fields; storing requests comes later
@Module({
  imports: [AuthModule, CampusModule],
  controllers: [RequestController],
  providers: [RequestService],
})
export class RequestModule {}
