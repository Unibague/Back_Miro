const express = require('express');
const router = express.Router();
const controller = require('../controllers/users.js');
const { requireAdmin, requireReadAccess } = require('../middleware/auth');

router.get("/all", controller.getUsers);

router.get("/allPagination", controller.getUsersPagination);

router.get("/roles", controller.getUserRoles);

router.get("/available-roles", controller.getAvailableRoles);

router.get("/available-profiles", controller.getAvailableProfiles);

router.get("/position-view-permissions", controller.getPositionViewPermissions);

router.get("/position-profiles", controller.getAccessProfiles);

router.get("/responsibles", controller.getResponsibles);

router.get("/producers", controller.getProducers);

router.put("/updateRole", requireAdmin, controller.updateUserRoles);

router.put("/updateProfiles", requireAdmin, controller.updateUserProfiles);

router.put("/position-view-permissions", requireAdmin, controller.updatePositionViewPermissions);

router.post("/position-members", requireAdmin, controller.addUserToPosition);

router.delete("/position-members", requireAdmin, controller.removeUserFromPosition);

router.post("/position-profiles", requireAdmin, controller.createAccessProfile);

router.put("/position-profiles/:id", requireAdmin, controller.updateAccessProfile);

router.delete("/position-profiles/:id", requireAdmin, controller.deleteAccessProfile);

router.put("/updateProducer", requireAdmin, controller.updateUsersToProducer);

router.put("/updateActiveRole", controller.updateUserActiveRole);

router.get("/", controller.getUser);

router.get("/impersonate", requireAdmin, controller.getUserToImpersonate);

router.post("/updateAll", requireAdmin, controller.loadUsers);

router.post("/addExternalUser", requireAdmin, controller.addExternalUser);

router.put("/updateStatus", requireAdmin, controller.updateUserStatus);

router.put("/migrate", requireAdmin, controller.migrateUserDependecy);

router.get("/:dep_code/users", controller.getUsersByDependency);


module.exports = router;
