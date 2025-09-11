const express = require('express')
const router = express.Router()
const controller = require('../controllers/dependencies.js')
const { requireAdmin, requireReadAccess } = require('../middleware/auth')

router.get("/all", controller.getDependencies)

router.get("/childrenDependencies/templates", controller.getChildrenDependenciesPublishedTemplates)

router.get("/responsible", controller.getDependencyByResponsible);

router.get("/:id/templates", controller.getTemplates)

router.get("/:id/reports", controller.getReports)

router.get("/:id", controller.getDependencyById);

router.get("/all/:email", controller.getAllDependencies)

router.get("/", controller.getDependency)

router.post("/updateAll", controller.loadDependencies)

// Rutas de escritura (solo para administradores)
router.put("/setResponsible", requireAdmin, controller.setResponsible)
router.put("/:id", requireAdmin, controller.updateDependency)
router.put("/:id/visualizers", requireAdmin, controller.updateVisualizers)

// Rutas de lectura (disponibles para líderes y administradores)
router.get("/:dep_code/members", controller.getMembers)

router.get("/members", controller.getMembersWithFather)

router.post("/names", controller.getDependencyNames);

router.get("/:email/hierarchy", controller.getDependencyHierarchy)

router.get("/:id/visualizers", controller.getVisualizers);







module.exports = router