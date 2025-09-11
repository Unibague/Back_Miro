const express = require('express');
const router = express.Router();
const controller = require('../controllers/users.js');
const { requireAdmin, requireReadAccess } = require('../middleware/auth');

router.get("/all", controller.getUsers);

router.get("/allPagination", controller.getUsersPagination);

router.get("/roles", controller.getUserRoles);

router.get("/available-roles", controller.getAvailableRoles);

router.get("/responsibles", controller.getResponsibles);

router.get("/producers", controller.getProducers);

router.put("/updateRole", requireAdmin, controller.updateUserRoles);

router.put("/updateProducer", requireAdmin, controller.updateUsersToProducer);

router.put("/updateActiveRole", requireAdmin, controller.updateUserActiveRole);

router.get("/", controller.getUser);

router.get("/impersonate", requireReadAccess, controller.getUserToImpersonate);

router.post("/updateAll", requireAdmin, controller.loadUsers);

router.post("/addExternalUser", requireAdmin, controller.addExternalUser);

router.put("/updateStatus", requireAdmin, controller.updateUserStatus);

router.put("/migrate", requireAdmin, controller.migrateUserDependecy);

router.get("/:dep_code/users", controller.getUsersByDependency);


module.exports = router;
