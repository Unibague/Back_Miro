const User = require('../models/users');
const Dependency = require('../models/dependencies');

const getUsersWithDependencies = async (req, res) => {
    try {
        const users = await User.getUsersWithAllDependencies();
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const updateUserDependencies = async (req, res) => {
    try {
        const { email } = req.params;
        const { additional_dependencies } = req.body;

        const user = await User.updateAdditionalDependencies(email, additional_dependencies);
        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        res.json({ message: 'Dependencias actualizadas correctamente', user });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getAllDependencies = async (req, res) => {
    try {
        const dependencies = await Dependency.find({}, 'dep_code name').sort({ name: 1 });
        res.json(dependencies);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getUsersWithDependencies,
    updateUserDependencies,
    getAllDependencies
};