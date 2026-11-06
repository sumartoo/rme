import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { EncountersController } from './encounters.controller';
import { PublicQueueDisplayController, QueueDisplaysController } from './queue-display.controller';
import { QueueEvents } from './queue-events';
import { QueueController } from './queue.controller';
import { SchedulesController } from './schedules.controller';

/** Jadwal dokter, janji temu, kunjungan, antrean & layar TV (Stage 8). Butuh Db & CONFIG global (CoreModule). */
@Module({
  controllers: [SchedulesController, AppointmentsController, EncountersController, QueueController, QueueDisplaysController, PublicQueueDisplayController],
  providers: [QueueEvents],
})
export class SchedulingModule {}
