import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { SchedulesController } from './schedules.controller';

/** Jadwal dokter & janji temu (Stage 8 batch 2). Butuh Db global (CoreModule). */
@Module({ controllers: [SchedulesController, AppointmentsController] })
export class SchedulingModule {}
