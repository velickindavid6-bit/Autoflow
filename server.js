import { loadConfig } from './src/config.js';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';

const config = loadConfig();
const db = openDb(config.dbFile);
const { server, telegram } = createApp({ config, db });

server.listen(config.port, config.host, () => {
  console.log(`AutoFlow запущен: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  if (!config.telegram.token) console.log('[telegram] TELEGRAM_BOT_TOKEN не задан: бот выключен (см. README, раздел «Telegram-бот»)');
  telegram.start();
});

const stop = () => { telegram.stop(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
