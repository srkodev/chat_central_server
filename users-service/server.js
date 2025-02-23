require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const http = require('http');
const { Sequelize, DataTypes, Op } = require('sequelize');
const { Server } = require('socket.io');

// Ajout de modules pour l'upload et la compression
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();

// Augmenter la limite du corps de la requête et configurer CORS
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: 'http://localhost:5173' }));

// Exposer le dossier des uploads en statique
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ----- Configuration de Sequelize (MariaDB) -----
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: 'mariadb',
    logging: false,
  }
);

// ----- Définition des Modèles -----
// Utilisateur avec informations de profil
const User = sequelize.define('User', {
  username: { type: DataTypes.STRING, unique: true, allowNull: false },
  password: { type: DataTypes.STRING, allowNull: false },
  bio: { type: DataTypes.TEXT, allowNull: true },
  avatar: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING, allowNull: true }
});

// Rôle
const Role = sequelize.define('Role', {
  name: { type: DataTypes.STRING, allowNull: false },
});
const UserRole = sequelize.define('UserRole', {
  userId: { type: DataTypes.INTEGER, allowNull: false },
  roleId: { type: DataTypes.INTEGER, allowNull: false },
});

// Amis (relation déjà acceptée)
const Friend = sequelize.define('Friend', {
  userId: { type: DataTypes.INTEGER, allowNull: false },
  friendId: { type: DataTypes.INTEGER, allowNull: false },
});

// Blocage d'utilisateurs
const Block = sequelize.define('Block', {
  blockerId: { type: DataTypes.INTEGER, allowNull: false },
  blockedId: { type: DataTypes.INTEGER, allowNull: false },
});

// Nouveau modèle pour les demandes d'amis
const FriendRequest = sequelize.define('FriendRequest', {
  requesterId: { type: DataTypes.INTEGER, allowNull: false },
  receiverId: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' }
});
// Association pour faciliter l'affichage des infos du demandeur
FriendRequest.belongsTo(User, { foreignKey: 'requesterId', as: 'requester' });

// SelfHostedServer
const SelfHostedServer = sequelize.define('SelfHostedServer', {
  domain: { type: DataTypes.STRING, allowNull: false },
  ip: { type: DataTypes.STRING, allowNull: true },
  config: { type: DataTypes.JSON, allowNull: true },
  ownerId: { type: DataTypes.INTEGER, allowNull: false }
});

// ----- Middleware JWT -----
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// ----- Configuration de Multer pour l'upload -----
const upload = multer({ storage: multer.memoryStorage() });
const AVATAR_UPLOAD_PATH = path.join(__dirname, 'uploads', 'avatars');
if (!fs.existsSync(AVATAR_UPLOAD_PATH)) {
  fs.mkdirSync(AVATAR_UPLOAD_PATH, { recursive: true });
}

// ----- Routes REST API -----
// Inscription
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({ username, password: hashedPassword });
    let memberRole = await Role.findOne({ where: { name: 'member' } });
    if (!memberRole) {
      memberRole = await Role.create({ name: 'member' });
    }
    await UserRole.create({ userId: newUser.id, roleId: memberRole.id });
    res.status(201).json({ message: 'Utilisateur créé', userId: newUser.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Connexion – Mise à jour pour renvoyer également le userId
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(400).json({ error: 'Utilisateur non trouvé' });
    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(403).json({ error: 'Mot de passe incorrect' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    console.log(`[DEBUG][Login] User ${user.username} connecté avec succès (ID: ${user.id})`);
    res.json({ token, userId: user.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Nouvel endpoint pour récupérer les informations d'un utilisateur par son ID
app.get('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const userData = await User.findOne({
      where: { id: req.params.id },
      attributes: ['id', 'username', 'avatar', 'status']
    });
    if (!userData) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    res.json(userData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer son profil
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const userData = await User.findOne({
      where: { id: req.user.id },
      attributes: ['id', 'username', 'bio', 'avatar', 'status']
    });
    if (userData && userData.bio === null) userData.bio = '';
    res.json(userData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mettre à jour son profil
app.put('/api/profile', authenticateToken, async (req, res) => {
  const { username, bio, avatar, status } = req.body;
  try {
    const userData = await User.findOne({ where: { id: req.user.id } });
    if (!userData) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    userData.username = username || userData.username;
    userData.bio = bio !== undefined ? bio : userData.bio;
    userData.avatar = avatar || userData.avatar;
    userData.status = status || userData.status;
    await userData.save();
    res.json({ message: 'Profil mis à jour', user: userData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint pour uploader et compresser l'avatar
app.post('/api/upload-avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier envoyé' });
    const filename = `avatar_${req.user.id}_${Date.now()}.jpeg`;
    const outputPath = path.join(AVATAR_UPLOAD_PATH, filename);
    await sharp(req.file.buffer)
      .resize(200, 200, { fit: sharp.fit.cover })
      .jpeg({ quality: 70 })
      .toFile(outputPath);
    const userData = await User.findOne({ where: { id: req.user.id } });
    if (!userData) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (userData.avatar) {
      const oldAvatarPath = path.join(__dirname, userData.avatar);
      if (fs.existsSync(oldAvatarPath)) fs.unlinkSync(oldAvatarPath);
    }
    const avatarUrl = `/uploads/avatars/${filename}`;
    userData.avatar = avatarUrl;
    await userData.save();
    res.json({ message: 'Avatar uploadé avec succès', avatar: avatarUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de l\'upload de l\'avatar' });
  }
});

// Endpoint pour rechercher des utilisateurs
app.get('/api/search-users', authenticateToken, async (req, res) => {
  try {
    const query = req.query.query;
    if (!query) return res.status(400).json({ error: "Le paramètre 'query' est requis." });
    const users = await User.findAll({
      where: {
        username: { [Op.like]: `%${query}%` },
        id: { [Op.ne]: req.user.id }
      },
      attributes: ['id', 'username', 'avatar']
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- DEMANDES D'AMIS ----------
app.post('/api/friend-requests', authenticateToken, async (req, res) => {
  const { friendUsername } = req.body;
  try {
    const receiver = await User.findOne({ where: { username: friendUsername } });
    if (!receiver) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const existingRequest = await FriendRequest.findOne({
      where: {
        requesterId: req.user.id,
        receiverId: receiver.id,
        status: 'pending'
      }
    });
    if (existingRequest) return res.status(400).json({ error: 'Demande déjà envoyée' });
    const alreadyFriends = await Friend.findOne({
      where: { userId: req.user.id, friendId: receiver.id }
    });
    if (alreadyFriends) return res.status(400).json({ error: 'Déjà amis' });
    const friendRequest = await FriendRequest.create({
      requesterId: req.user.id,
      receiverId: receiver.id
    });
    res.status(201).json({ message: 'Demande d\'ami envoyée', friendRequest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/friend-requests', authenticateToken, async (req, res) => {
  try {
    const requests = await FriendRequest.findAll({
      where: { receiverId: req.user.id, status: 'pending' },
      include: { model: User, as: 'requester', attributes: ['id', 'username', 'avatar'] }
    });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/friend-requests/:requestId/accept', authenticateToken, async (req, res) => {
  try {
    const requestId = req.params.requestId;
    const friendRequest = await FriendRequest.findOne({
      where: { id: requestId, receiverId: req.user.id, status: 'pending' }
    });
    if (!friendRequest) return res.status(404).json({ error: 'Demande non trouvée' });
    friendRequest.status = 'accepted';
    await friendRequest.save();
    await Friend.create({ userId: friendRequest.requesterId, friendId: friendRequest.receiverId });
    await Friend.create({ userId: friendRequest.receiverId, friendId: friendRequest.requesterId });
    res.json({ message: 'Demande acceptée, vous êtes maintenant amis' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/friend-requests/:requestId', authenticateToken, async (req, res) => {
  try {
    const requestId = req.params.requestId;
    const friendRequest = await FriendRequest.findOne({
      where: { id: requestId, receiverId: req.user.id, status: 'pending' }
    });
    if (!friendRequest) return res.status(404).json({ error: 'Demande non trouvée' });
    await friendRequest.destroy();
    res.json({ message: 'Demande rejetée' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ---------- FIN DEMANDES D'AMIS ----------

app.get('/api/friends', authenticateToken, async (req, res) => {
  try {
    const friends = await Friend.findAll({ where: { userId: req.user.id } });
    const friendDetails = await Promise.all(
      friends.map(async (f) => {
        return await User.findOne({
          where: { id: f.friendId },
          attributes: ['id', 'username', 'avatar', 'status']
        });
      })
    );
    res.json(friendDetails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/friends', authenticateToken, async (req, res) => {
  const { friendUsername } = req.body;
  try {
    const friendUser = await User.findOne({ where: { username: friendUsername } });
    if (!friendUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const existing = await Friend.findOne({ where: { userId: req.user.id, friendId: friendUser.id } });
    if (existing) return res.status(400).json({ error: 'Déjà amis' });
    await Friend.create({ userId: req.user.id, friendId: friendUser.id });
    res.status(201).json({ message: 'Ami ajouté', friend: friendUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/friends/:friendId', authenticateToken, async (req, res) => {
  try {
    const deleted = await Friend.destroy({ where: { userId: req.user.id, friendId: req.params.friendId } });
    if (deleted) {
      res.json({ message: 'Ami supprimé' });
    } else {
      res.status(404).json({ error: 'Ami non trouvé' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/friends/block', authenticateToken, async (req, res) => {
  const { blockedUsername } = req.body;
  try {
    const blockedUser = await User.findOne({ where: { username: blockedUsername } });
    if (!blockedUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const existing = await Block.findOne({ where: { blockerId: req.user.id, blockedId: blockedUser.id } });
    if (existing) return res.status(400).json({ error: 'Utilisateur déjà bloqué' });
    await Block.create({ blockerId: req.user.id, blockedId: blockedUser.id });
    res.status(201).json({ message: 'Utilisateur bloqué', blockedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/friends/blocked', authenticateToken, async (req, res) => {
  try {
    const blocks = await Block.findAll({ where: { blockerId: req.user.id } });
    const blockedUsers = await Promise.all(
      blocks.map(async (b) => {
        return await User.findOne({
          where: { id: b.blockedId },
          attributes: ['id', 'username']
        });
      })
    );
    res.json(blockedUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/friends/block/:blockedId', authenticateToken, async (req, res) => {
  try {
    const deleted = await Block.destroy({ where: { blockerId: req.user.id, blockedId: req.params.blockedId } });
    if (deleted) {
      res.json({ message: 'Utilisateur débloqué' });
    } else {
      res.status(404).json({ error: 'Utilisateur non bloqué' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Endpoints pour gérer les serveurs auto-hébergés =====
app.post('/api/selfhosted', authenticateToken, async (req, res) => {
  const { domain, ip, config } = req.body;
  if (!domain) return res.status(400).json({ error: 'Le domaine est requis.' });
  try {
    const serverInstance = await SelfHostedServer.create({
      domain,
      ip: ip || null,
      config: config || {},
      ownerId: req.user.id
    });
    res.status(201).json({ message: 'Serveur auto-hébergé créé', server: serverInstance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/selfhosted', authenticateToken, async (req, res) => {
  try {
    const servers = await SelfHostedServer.findAll({ where: { ownerId: req.user.id } });
    res.json(servers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/selfhosted/:serverId', authenticateToken, async (req, res) => {
  const { serverId } = req.params;
  const { domain, ip, config } = req.body;
  try {
    const serverInstance = await SelfHostedServer.findOne({ where: { id: serverId, ownerId: req.user.id } });
    if (!serverInstance) return res.status(404).json({ error: 'Serveur non trouvé ou accès refusé.' });
    serverInstance.domain = domain || serverInstance.domain;
    serverInstance.ip = ip || serverInstance.ip;
    serverInstance.config = config || serverInstance.config;
    await serverInstance.save();
    res.json({ message: 'Serveur mis à jour', server: serverInstance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/selfhosted/:serverId', authenticateToken, async (req, res) => {
  const { serverId } = req.params;
  try {
    const deleted = await SelfHostedServer.destroy({ where: { id: serverId, ownerId: req.user.id } });
    if (deleted) {
      res.json({ message: 'Serveur supprimé' });
    } else {
      res.status(404).json({ error: 'Serveur non trouvé ou accès refusé.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Intégration de Socket.io pour la signalisation -----
const serverHttp = http.createServer(app);
const io = new Server(serverHttp, {
  cors: { origin: 'http://localhost:5173' }
});
const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentification obligatoire"));
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return next(new Error("Token invalide"));
    socket.user = user;
    console.log(`[DEBUG][Socket] User connecté: ${socket.user.username} (ID: ${socket.user.id})`);
    next();
  });
});

io.on('connection', (socket) => {
  console.log(`Nouvelle connexion : ${socket.user.username}`);
  onlineUsers.set(socket.user.id, socket);
  socket.on('callUser', (data) => {
    console.log(`[DEBUG][Socket] callUser from ${socket.user.id} to ${data.targetUserId}`, data);
    const targetSocket = onlineUsers.get(data.targetUserId);
    if (targetSocket) {
      console.log(`[DEBUG][Socket] Envoi d'incomingCall à ${data.targetUserId}`);
      targetSocket.emit('incomingCall', { from: socket.user.id, offer: data.offer });
    } else {
      console.log(`[DEBUG][Socket] Utilisateur ${data.targetUserId} non connecté`);
    }
  });
  socket.on('answerCall', (data) => {
    console.log(`[DEBUG][Socket] answerCall from ${socket.user.id} to ${data.targetUserId}`);
    const targetSocket = onlineUsers.get(data.targetUserId);
    if (targetSocket) {
      targetSocket.emit('callAnswered', { from: socket.user.id, answer: data.answer });
    }
  });
  socket.on('iceCandidate', (data) => {
    console.log(`[DEBUG][Socket] iceCandidate from ${socket.user.id} to ${data.targetUserId}`);
    const targetSocket = onlineUsers.get(data.targetUserId);
    if (targetSocket) {
      targetSocket.emit('iceCandidate', { from: socket.user.id, candidate: data.candidate });
    }
  });
  socket.on('disconnect', () => {
    console.log(`Déconnexion : ${socket.user.username}`);
    onlineUsers.delete(socket.user.id);
  });
});

// ----- Démarrage du serveur -----
const PORT_SERVER = process.env.PORT || 4000;
sequelize.sync({ alter: true })
  .then(() => {
    serverHttp.listen(PORT_SERVER, () => console.log(`Users service running on port ${PORT_SERVER}`));
  })
  .catch((err) => {
    console.error('Erreur lors de la synchronisation de la base :', err);
  });
