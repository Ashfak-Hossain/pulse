import { Module } from '@nestjs/common';
import { CourseController } from './course.controller.js';
import { CourseService } from './course.service.js';

@Module({ controllers: [CourseController], providers: [CourseService] })
export class CourseModule {}
