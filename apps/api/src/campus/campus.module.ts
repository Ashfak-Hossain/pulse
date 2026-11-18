import { Module } from '@nestjs/common';
import { CampusController } from './campus.controller.js';
import { CampusService } from './campus.service.js';
import { AdminCampusController } from './admin-campus.controller.js';

@Module({
  controllers: [CampusController, AdminCampusController],
  providers: [CampusService],
  // Course and catalog look campuses up by slug through it
  exports: [CampusService],
})
export class CampusModule {}
