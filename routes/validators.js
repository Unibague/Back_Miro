const controller = require('../controllers/validators')
const { requireAdmin } = require('../middleware/auth')

const router = require('express').Router()

router.post("/create", requireAdmin, controller.createValidator)
router.put("/updateName", requireAdmin, controller.updateName)
router.put("/update", requireAdmin, controller.updateValidator)
router.get("/options", controller.getValidatorOptions)
router.get("/", controller.getValidator)
router.get("/all", controller.getValidators)
router.get("/pagination", controller.getValidatorsWithPagination)
router.delete("/delete", requireAdmin, controller.deleteValidator)
router.get("/id", controller.getValidatorById)
router.get("/allValidators", controller.getAllValidators)

module.exports = router