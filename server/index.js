'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { handleConnection, getMetrics } = require('./gameManager');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/metrics', (_req, res) => res.json(getMetrics()));

app.get('/metrics', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'metrics.html'));
});

// Serve index.html for any unmatched route (SPA fallback)
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', handleConnection);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SimulChess server listening on port ${PORT}`);
});
