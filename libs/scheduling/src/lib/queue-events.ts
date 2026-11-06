import { EventEmitter } from 'node:events';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'pg';
import { type AppConfig, CONFIG } from '@clinicrme/shared';

export const QUEUE_CHANNEL = 'clinicrme_queue';

/**
 * OD-089: satu koneksi PostgreSQL per proses API yang LISTEN `clinicrme_queue`. Setiap perubahan antrean
 * (walk-in, check-in, panggil, lewati, batal) mengirim NOTIFY berisi `<tenant>:<cabang>` saja — tanpa data pasien.
 * Pelanggan (stream SSE layar TV) mendaftar per `<tenant>:<cabang>`. Koneksi dibuka saat pelanggan pertama datang
 * dan disambung ulang otomatis bila putus.
 */
@Injectable()
export class QueueEvents implements OnModuleDestroy {
  private readonly log = new Logger('QueueEvents');
  private readonly bus = new EventEmitter().setMaxListeners(0);
  private client?: Client;
  private connecting?: Promise<void>;
  private stopped = false;

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  async subscribe(key: string, fn: () => void): Promise<() => void> {
    this.bus.on(key, fn);
    await this.ensure();
    return () => { this.bus.off(key, fn); };
  }

  private async ensure() {
    if (this.client || this.stopped) return;
    this.connecting ??= (async () => {
      const c = new Client({ connectionString: this.cfg.db.url, application_name: 'clinicrme-api-queue-listen' });
      c.on('notification', (n) => { if (n.channel === QUEUE_CHANNEL && n.payload) this.bus.emit(n.payload); });
      c.on('error', (err) => {
        this.log.warn(`koneksi LISTEN putus: ${err.message}`);
        this.client = undefined;
        void c.end().catch(() => undefined);
        if (!this.stopped) setTimeout(() => void this.ensure(), 2000);
      });
      await c.connect();
      await c.query(`LISTEN ${QUEUE_CHANNEL}`);
      this.client = c;
    })().finally(() => { this.connecting = undefined; });
    await this.connecting;
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.client?.end().catch(() => undefined);
  }
}
