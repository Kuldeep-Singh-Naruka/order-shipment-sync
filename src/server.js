const express = require('express');
const config = require('./config');

const app = express();

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port}`);
});
