const express = require('express');
const router = express.Router();
const graph = require('../services/graph');

router.get('/microsoft', (req, res) => {
  res.redirect(graph.getAuthUrl());
});

router.get('/microsoft/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Auth error: ${error}`);
  if (!code) return res.status(400).send('No auth code received');

  try {
    await graph.exchangeCode(code);
    // Subscribe to calendar after successful auth
    const notificationUrl = `${process.env.FRONTEND_URL?.replace('3000', '3001') || 'http://localhost:3001'}/webhooks/calendar-event`;
    try {
      await graph.subscribeToCalendar(notificationUrl);
    } catch (e) {
      console.warn('[Auth] Calendar subscription failed (non-fatal):', e.message);
    }
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?connected=microsoft`);
  } catch (e) {
    console.error('[Auth] Microsoft callback error:', e);
    res.status(500).send(`Authentication failed: ${e.message}`);
  }
});

router.get('/status', async (req, res) => {
  try {
    await graph.getAccessToken();
    res.json({ microsoft: true });
  } catch {
    res.json({ microsoft: false });
  }
});

module.exports = router;
