const express = require('express');
const router = express.Router();
const { getUsersWithDependencies, updateUserDependencies, getAllDependencies } = require('../controllers/userDependencies');

router.get('/users-with-dependencies', getUsersWithDependencies);
router.put('/users/:email/dependencies', updateUserDependencies);
router.get('/dependencies-list', getAllDependencies);

module.exports = router;