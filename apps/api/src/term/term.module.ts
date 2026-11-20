import { Module } from '@nestjs/common';
import { AdminTermController } from './admin-term.controller.js';
import { TermService } from './term.service.js';

@Module({ controllers: [AdminTermController], providers: [TermService] })
export class TermModule {}
