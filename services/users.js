const User = require("../models/users");
const axios = require("axios");

class UserService {
  static async findUserByEmail(email, session) {
    const user = await User.findOne({ email, isActive: true }).session(session)
    if (!user) throw new Error("User not found.")
    return user;
  }

  static async findUserByEmailAndRole(email, role, session) {
    const user = await User.findOne({ email, activeRole: role, isActive: true })
      .sort({ updatedAt: -1 })
      .session(session);
    if (!user) {
      throw new Error("User not found.");
    }
    return user;
  }

  static async findUserByEmailAndRoles(email, roles) {
    const user = await User.findOne({ email, activeRole: { $in: roles } });
    if (!user) throw new Error("User not found.");
    return user;
  }
  static async giveUsersToKeepAndDelete() {
    try {
      const response = await axios.get(process.env.USERS_ENDPOINT);
      const externalUserEmails = new Set(response.data.map(user => user.email));
      const [usersToKeep, usersToDelete] = await Promise.all([
        User.find({ email: { $in: Array.from(externalUserEmails) } }),
        User.find({ email: { $nin: Array.from(externalUserEmails) } }).distinct('email')
      ]);
      return {usersToKeep, usersToDelete};
    } catch (error) {
      throw new Error(error.message);
    }
  }
}
  


module.exports = UserService;