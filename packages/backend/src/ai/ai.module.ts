import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { AiTraceService } from './trace.service.js';

@Module({
  controllers: [AiController],
  providers: [
    AiService,
    {
      provide: AiTraceService,
      useFactory: () => AiTraceService.getInstance(),
    },
  ],
  exports: [AiService, AiTraceService],
})
export class AiModule {}
