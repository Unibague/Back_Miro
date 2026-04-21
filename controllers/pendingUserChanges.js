const PendingUserChanges = require('../models/pendingUserChanges');
const User = require('../models/users');
const Dependency = require('../models/dependencies');
const UserService = require('../services/users');
const dependencyController = require('./dependencies');

const pendingChangesController = {};

// Obtener todos los cambios pendientes
pendingChangesController.getPendingChanges = async (req, res) => {
  try {
    const { email } = req.query;
    
    // Verificar que sea administrado
    await UserService.findUserByEmailAndRole(email, 'Administrador');
    
    const pendingChanges = await PendingUserChanges.find({ status: 'pending' })
      .sort({ detected_date: -1 });
    
    res.status(200).json({ pendingChanges });
  } catch (error) {
    console.error('Error fetching pending changes:', error);
    res.status(500).json({ error: error.message });
  }
};

// Aprobar cambios seleccionados
pendingChangesController.approveChanges = async (req, res) => {
  try {
    const { email, changeIds } = req.body;
    
    // Verificar que sea administrador
    const admin = await UserService.findUserByEmailAndRole(email, 'Administrador');
    
    const changes = await PendingUserChanges.find({ 
      _id: { $in: changeIds }, 
      status: 'pending' 
    });
    
    if (changes.length === 0) {
      return res.status(404).json({ error: 'No pending changes found' });
    }
    
    // Aplicar los cambios aprobados
    for (const change of changes) {
      try {
        // Actualizar dep_code del usuario
        await User.findOneAndUpdate(
          { email: change.user_email },
          { dep_code: change.proposed_value }
        );
        
        // Mover usuario a la nueva dependencia
        await dependencyController.addUserToDependency(
          change.proposed_value, 
          change.user_email
        );
        
        // Marcar cambio como aprobado
        change.status = 'approved';
        change.reviewed_by = admin.email;
        change.reviewed_date = new Date();
        await change.save();
        
        console.log(`Change approved: ${change.user_email} -> ${change.proposed_dependency_name}`);
      } catch (error) {
        console.error(`Error applying change for ${change.user_email}:`, error);
      }
    }
    
    res.status(200).json({ 
      message: `${changes.length} changes approved successfully`,
      approvedChanges: changes.length
    });
  } catch (error) {
    console.error('Error approving changes:', error);
    res.status(500).json({ error: error.message });
  }
};

// Rechazar cambios seleccionados
pendingChangesController.rejectChanges = async (req, res) => {
  try {
    const { email, changeIds } = req.body;
    
    // Verificar que sea administrador
    const admin = await UserService.findUserByEmailAndRole(email, 'Administrador');
    
    const result = await PendingUserChanges.updateMany(
      { _id: { $in: changeIds }, status: 'pending' },
      { 
        status: 'rejected',
        reviewed_by: admin.email,
        reviewed_date: new Date()
      }
    );
    
    res.status(200).json({ 
      message: `${result.modifiedCount} changes rejected successfully`,
      rejectedChanges: result.modifiedCount
    });
  } catch (error) {
    console.error('Error rejecting changes:', error);
    res.status(500).json({ error: error.message });
  }
};

// Obtener historial de cambios (aprobados y rechazados)
pendingChangesController.getChangesHistory = async (req, res) => {
  try {
    const { email, page = 1, limit = 20 } = req.query;
    
    // Verificar que sea administrador
    await UserService.findUserByEmailAndRole(email, 'Administrador');
    
    const skip = (page - 1) * limit;
    
    const changes = await PendingUserChanges.find({ 
      status: { $in: ['approved', 'rejected'] } 
    })
      .sort({ reviewed_date: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await PendingUserChanges.countDocuments({ 
      status: { $in: ['approved', 'rejected'] } 
    });
    
    res.status(200).json({ 
      changes,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching changes history:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = pendingChangesController;