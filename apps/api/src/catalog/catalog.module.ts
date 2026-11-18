import { Module } from '@nestjs/common';
import { CampusModule } from '../campus/campus.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({ imports: [CampusModule], controllers: [CatalogController], providers: [CatalogService] })
export class CatalogModule {}
