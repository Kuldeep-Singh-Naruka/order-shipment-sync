require('dotenv').config({ quiet: true });

module.exports = {
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DB_PATH || 'data.db',
  webhookSecret: process.env.WEBHOOK_SECRET,
  courierUrl: process.env.COURIER_URL || 'http://localhost:4000',
};
