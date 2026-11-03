import { Module } from '@nestjs/common';
import { CampusController } from './campus.controller.js';
import { CampusService } from './campus.service.js';
import { AdminCampusController } from './admin-campus.controller.js';

@Module({
  controllers: [CampusController, AdminCampusController],
  providers: [CampusService],
})
export class CampusModule {}
