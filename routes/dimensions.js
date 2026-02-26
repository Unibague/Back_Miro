const express = require('express');

const router = express.Router();

const controller = require('../controllers/dimensions.js');

router.get("/", controller.getDimensions);

router.get("/all", controller.getDimensionsPagination);

router.get("/responsible", controller.getDimensionsByResponsible);

router.post("/create", controller.createDimension);

router.put("/:id", controller.updateDimension);

router.delete("/:id", controller.deleteDimension);

router.get("/producers/:id", controller.getProducers);

router.get("/user/:email", controller.getDimensionsByUser);

router.get("/:id", controller.getDimensionById);

module.exports = router;