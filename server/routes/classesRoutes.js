const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const peptides101ClassesController = require('../controllers/peptides101ClassesController');

const router = Router();

router.get('/peptides-101', authenticate, peptides101ClassesController.list);

module.exports = router;

