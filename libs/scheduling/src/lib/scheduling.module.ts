import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { EncountersController } from './encounters.controller';
import { QueueController } from './queue.controller';
import { SchedulesController } from './schedules.controller';

/** Jadwal dokter, janji temu, kunjungan & antrean (Stage 8 batch 2–3). Butuh Db global (CoreModule). */
@Module({ controllers: [SchedulesController, AppointmentsController, EncountersController, QueueController] })
export class SchedulingModule {}
