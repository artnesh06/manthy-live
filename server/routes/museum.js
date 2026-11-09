const express = require('express');
const router = express.Router();
const { all, get } = require('../db');

router.get('/', (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  const exhibits = all('SELECT * FROM museum ORDER BY caught_at DESC LIMIT ? OFFSET ?', [Number(limit), Number(offset)]);
  const total = get('SELECT COUNT(*) as count FROM museum')?.count || 0;
  res.json({ exhibits, total });
});

module.exports = router;
