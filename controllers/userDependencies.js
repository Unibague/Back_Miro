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
        const { additionalDependencies } = req.body;
        const additional_dependencies = additionalDependencies; // Mapear al nombre interno

        // Validar que additional_dependencies sea un array
        if (additional_dependencies && !Array.isArray(additional_dependencies)) {
            return res.status(400).json({ message: 'additionalDependencies debe ser un array' });
        }

        // Obtener dependencias anteriores del usuario
        const currentUser = await User.findOne({ email });
        if (!currentUser) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        const previousDependencies = currentUser.additional_dependencies || [];
        
        // Actualizar dependencias
        const user = await User.updateAdditionalDependencies(email, additional_dependencies);
        
        // Obtener todas las dependencias del usuario (principal + adicionales)
        const allUserDependencies = await getUserAllDependencies(user);
        
        // Detectar nuevas dependencias agregadas
        const newDependencies = (additional_dependencies || []).filter(
            depId => !previousDependencies.includes(depId)
        );
        
        // Si hay nuevas dependencias, enviar email
        if (newDependencies.length > 0) {
            await sendDependencyUpdateEmail(user, allUserDependencies, newDependencies);
        }

        res.json({ 
            message: 'Dependencias actualizadas correctamente', 
            user,
            allDependencies: allUserDependencies
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Función para obtener todas las dependencias del usuario
const getUserAllDependencies = async (user) => {
    const dependencies = [];
    
    // Dependencia principal
    const mainDep = await Dependency.findOne({ dep_code: user.dep_code });
    if (mainDep) {
        dependencies.push({
            name: mainDep.name,
            dep_code: mainDep.dep_code,
            type: 'principal'
        });
    }
    
    // Dependencias adicionales
    if (user.additional_dependencies && user.additional_dependencies.length > 0) {
        const additionalDeps = await Dependency.find({ 
            dep_code: { $in: user.additional_dependencies } 
        });
        
        additionalDeps.forEach(dep => {
            dependencies.push({
                name: dep.name,
                dep_code: dep.dep_code,
                type: 'adicional'
            });
        });
    }
    
    return dependencies;
};

// Función para enviar email de actualización de dependencias
const sendDependencyUpdateEmail = async (user, allDependencies, newDependencyIds) => {
    const RemindersService = require('../services/reminders');
    
    // Obtener información de las nuevas dependencias
    const newDeps = await Dependency.find({ dep_code: { $in: newDependencyIds } });
    const newDepNames = newDeps.map(dep => dep.name);
    
    // Crear el contenido del email
    const dependenciesList = allDependencies.map(dep => 
        `<li><strong>${dep.name}</strong> (${dep.dep_code}) - <em>${dep.type}</em></li>`
    ).join('');
    
    await sendDependencyNotificationEmail(
        user.email,
        user.full_name,
        newDepNames,
        allDependencies
    );
};

const getAllDependencies = async (req, res) => {
    try {
        const dependencies = await Dependency.find({}, 'dep_code name').sort({ name: 1 });
        res.json(dependencies);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Función para enviar email de notificación de dependencias
const sendDependencyNotificationEmail = async (to, userName, newDependencies, allDependencies) => {
    const nodemailer = require('nodemailer');
    
    const transporter = nodemailer.createTransport({
        host: 'smtp.pepipost.com',
        port: 587,
        secure: false,
        auth: {
            user: process.env.REMINDER_EMAIL,
            pass: process.env.REMINDER_PASS
        },
        tls: {
            rejectUnauthorized: false
        }
    });
    
    // Crear filas de la tabla con todas las dependencias
    const dependenciesTableRows = allDependencies.map(dep => 
        `<tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 12px 15px; font-weight: 500;">${dep.name}</td>
            <td style="padding: 12px 15px; text-align: center; font-size: 14px;">${dep.dep_code}</td>
            <td style="padding: 12px 15px; text-align: center;">
                <span style="background: ${dep.type === 'principal' ? '#28a745' : '#007bff'}; color: white; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: bold;">
                    ${dep.type === 'principal' ? 'PRINCIPAL' : 'ADICIONAL'}
                </span>
            </td>
        </tr>`
    ).join('');
    
    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; max-width: 700px; margin: auto; background-color: #f9f9f9; border-radius: 8px; border: 1px solid #ddd;">
            <div style="text-align: left;">
                <img src="https://miro.unibague.edu.co/MIRO.png" alt="Logo Miró" width="64" height="64" />
            </div>
            
            <h2 style="color: #1d3557; text-align: center;">Actualización de Dependencias</h2>
            
            <p style="font-size: 16px;">Hola <strong>${userName}</strong>,</p>
            
            <p style="font-size: 16px;">
                Se te han agregado más dependencias a la aplicación. Estas son las dependencias que tienes actualmente después de haber hecho los cambios en la aplicación:
            </p>
            
            <div style="margin: 20px 0;">
                <table style="width: 100%; border-collapse: collapse; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <thead>
                        <tr style="background: #003D7C; color: white;">
                            <th style="padding: 15px; text-align: left; font-weight: bold;">Dependencia</th>
                            <th style="padding: 15px; text-align: center; font-weight: bold;">Código</th>
                            <th style="padding: 15px; text-align: center; font-weight: bold;">Tipo</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${dependenciesTableRows}
                    </tbody>
                </table>
            </div>
            
            <div style="background-color: #d1ecf1; border: 1px solid #bee5eb; padding: 12px 16px; border-radius: 6px; margin: 16px 0;">
                <p style="margin: 0; font-size: 15px; color: #0c5460;">
                    ℹ️ <strong>Importante:</strong> Ahora tienes acceso a gestionar información de todas estas dependencias en la plataforma MIRÓ.
                </p>
            </div>
            
            <div style="margin: 24px 0; text-align: center;">
                <a href="https://miro.unibague.edu.co" 
                   style="background-color: #457b9d; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; display: inline-block;">
                    Acceder a MIRÓ
                </a>
            </div>
            
            <p style="font-size: 14px; color: #6c757d;">
                Este mensaje fue generado automáticamente por la plataforma MIRÓ. Si tienes alguna inquietud, por favor escribe al correo electrónico direcciondeplaneacion@unibague.edu.co
            </p>
            
            <hr style="border: none; border-top: 1px solid #ccc; margin: 30px 0;">
            <p style="font-size: 14px; text-align: center; color: #999;">— Equipo MIRÓ</p>
        </div>
    `;
    
    await transporter.sendMail({
        from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
        to,
        subject: "📋 Actualización de Dependencias - Sistema MIRÓ",
        html
    });
};

// Endpoint para obtener todas las dependencias de un usuario específico
const getUserDependencies = async (req, res) => {
    try {
        const { email } = req.params;
        
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }
        
        const allDependencies = await getUserAllDependencies(user);
        
        res.json({ 
            user: {
                email: user.email,
                full_name: user.full_name,
                dep_code: user.dep_code
            },
            dependencies: allDependencies 
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getSecondaryMembers = async (req, res) => {
    try {
        const { dep_code } = req.params;
        
        const users = await User.find(
            { 
                additional_dependencies: dep_code,
                isActive: true 
            },
            { email: 1, full_name: 1, _id: 0 }
        );

        res.json(users);
    } catch (error) {
        console.error('Error getting secondary members:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    getUsersWithDependencies,
    updateUserDependencies,
    getAllDependencies,
    getUserDependencies,
    getSecondaryMembers
};