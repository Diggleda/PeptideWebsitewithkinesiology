const { Router } = require('express');
const peptideForumController = require('../controllers/peptideForumController');

const router = Router();

// Public: used on the login/info page; keep it unauthenticated to avoid CORS preflight.
router.get('/the-peptide-forum', peptideForumController.list);

module.exports = router;
