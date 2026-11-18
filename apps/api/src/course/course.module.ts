import { Module } from '@nestjs/common';
import { CampusModule } from '../campus/campus.module.js';
import { CourseController } from './course.controller.js';
import { CourseService } from './course.service.js';

@Module({ imports: [CampusModule], controllers: [CourseController], providers: [CourseService] })
export class CourseModule {}
