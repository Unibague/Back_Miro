const express = require('express');
const router = express.Router();
const { getUsersWithDependencies, updateUserDependencies, getAllDependencies, getUserDependencies, getSecondaryMembers } = require('../controllers/userDependencies');
const { requireAdmin, requireReadAccess } = require('../middleware/auth');

// Rutas de solo lectura (disponibles para líderes y administradores)
router.get('/users-with-dependencies', getUsersWithDependencies);
router.get('/dependencies-list', getAllDependencies);
router.get('/users/:email/all-dependencies', getUserDependencies);
router.get('/dependency/:dep_code/secondary-members', getSecondaryMembers);

// Rutas de escritura (solo para administradores)
router.put('/users/:email/dependencies', requireAdmin, updateUserDependencies);

module.exports = router;