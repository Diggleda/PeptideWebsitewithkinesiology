const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const peptideForumController = require('../controllers/peptideForumController');

const router = Router();

router.get('/the-peptide-forum', authenticate, peptideForumController.list);

module.exports = router;

