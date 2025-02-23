require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Schema } = mongoose;
const http = require('http');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const { PORT, JWT_SECRET, MONGO_URI } = process.env;

mongoose
  .connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000
  })
  .then(() => console.log('Connected to MongoDB for messages service'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Schema pour les messages
const messageSchema = new Schema({
  content: { type: String, required: true },
  senderId: { type: Number, required: true },
  recipientId: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
  replyTo: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
  reactions: [{
    emoji: { type: String },
    count: { type: Number, default: 0 },
    users: [{ type: Number }]
  }],
  isEdited: { type: Boolean, default: false }
});

const Message = mongoose.model('Message', messageSchema);

// Middleware d'authentification JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    console.log('Aucun token trouvé');
    return res.sendStatus(401);
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('Erreur de vérification du token:', err);
      return res.sendStatus(403);
    }
    req.user = user;
    console.log('Token vérifié pour l\'utilisateur:', user.id);
    next();
  });
};

// Middleware d'authentification Socket.IO
const authenticateSocketToken = (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        return next(new Error('Authentication error: Invalid token'));
      }
      socket.user = user;
      next();
    });
  } catch (error) {
    next(new Error('Authentication error: ' + error.message));
  }
};

// Créer le serveur HTTP
const server = http.createServer(app);

// Configuration de Socket.IO avec gestion des erreurs
const io = require('socket.io')(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Structure pour stocker les connexions des utilisateurs
class UserConnections {
  constructor() {
    this.connections = new Map();
  }

  add(userId, socket) {
    const userConnection = {
      socket,
      timestamp: Date.now(),
      calls: new Map()
    };
    this.connections.set(userId, userConnection);
    return userConnection;
  }

  remove(userId) {
    const connection = this.connections.get(userId);
    if (connection) {
      // Nettoyer les appels en cours
      connection.calls.forEach((call, callId) => {
        this.endCall(userId, callId);
      });
      this.connections.delete(userId);
    }
  }

  get(userId) {
    return this.connections.get(userId);
  }

  addCall(userId, callId, data) {
    const connection = this.connections.get(userId);
    if (connection) {
      connection.calls.set(callId, data);
    }
  }

  endCall(userId, callId) {
    const connection = this.connections.get(userId);
    if (connection) {
      const callData = connection.calls.get(callId);
      if (callData) {
        // Notifier l'autre participant
        const otherParticipant = this.connections.get(callData.otherParticipantId);
        if (otherParticipant) {
          otherParticipant.socket.emit('callEnded', { 
            from: userId,
            reason: 'REMOTE_ENDED'
          });
        }
        connection.calls.delete(callId);
      }
    }
  }
}

const connectedUsers = new UserConnections();

io.use(authenticateSocketToken);

io.on('connection', (socket) => {
  console.log('Un client est connecté:', socket.user.id);
  
  const userConnection = connectedUsers.add(socket.user.id, socket);

  // Gestion des messages
  socket.on('sendMessage', (message) => {
    socket.broadcast.emit('newMessage', message);
  });

  // Gestion des appels
  socket.on('callUser', (data) => {
    console.log('[DEBUG] callUser event reçu:', data);
    const targetConnection = connectedUsers.get(data.userToCall);
    
    if (targetConnection) {
      // Générer un ID unique pour l'appel
      const callId = `${socket.user.id}-${data.userToCall}-${Date.now()}`;
      
      // Stocker les informations de l'appel
      connectedUsers.addCall(socket.user.id, callId, {
        otherParticipantId: data.userToCall,
        type: data.callType,
        startTime: Date.now()
      });

      console.log(`[DEBUG] Envoi de l'appel entrant à l'utilisateur ${data.userToCall} depuis ${data.from}`);
      targetConnection.socket.emit('callIncoming', {
        callId,
        signal: data.signalData,
        from: data.from,
        callType: data.callType
      });
    } else {
      console.log(`[DEBUG] Utilisateur ${data.userToCall} non connecté`);
      socket.emit('callFailed', {
        error: 'USER_UNAVAILABLE',
        message: 'L\'utilisateur n\'est pas connecté'
      });
    }
  });

  socket.on('answerCall', (data) => {
    console.log('[DEBUG] answerCall event reçu:', data);
    const targetConnection = connectedUsers.get(data.to);
    
    if (targetConnection) {
      console.log(`[DEBUG] Transmission de la réponse d'appel à l'utilisateur ${data.to}`);
      targetConnection.socket.emit('callAnswered', {
        signal: data.signal,
        from: socket.user.id
      });
    }
  });

  socket.on('callCandidate', (data) => {
    console.log('[DEBUG] callCandidate event reçu:', data);
    const targetConnection = connectedUsers.get(data.to);
    
    if (targetConnection) {
      console.log(`[DEBUG] Transmission du candidat ICE à l'utilisateur ${data.to}`);
      targetConnection.socket.emit('callCandidate', {
        candidate: data.candidate,
        from: socket.user.id
      });
    }
  });

  socket.on('endCall', (data) => {
    console.log('[DEBUG] endCall event reçu:', data);
    if (data.callId) {
      connectedUsers.endCall(socket.user.id, data.callId);
    } else {
      // Fallback pour la compatibilité
      const targetConnection = connectedUsers.get(data.to);
      if (targetConnection) {
        targetConnection.socket.emit('callEnded', { 
          from: socket.user.id,
          reason: data.reason || 'NORMAL'
        });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('Un client s\'est déconnecté:', socket.user.id);
    connectedUsers.remove(socket.user.id);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
    // Nettoyer les ressources si nécessaire
    connectedUsers.remove(socket.user.id);
  });
});

// Routes pour la messagerie
app.post('/api/messages', authenticateToken, async (req, res) => {
  const { content, recipientId, replyTo } = req.body;
  try {
    const msgData = {
      content,
      senderId: req.user.id,
      recipientId: recipientId || null,
    };
    
    if (replyTo) {
      msgData.replyTo = replyTo;
    }
    
    const msg = new Message(msgData);
    await msg.save();
    
    if (replyTo) {
      await msg.populate('replyTo');
    }
    
    io.emit('newMessage', msg);
    console.log('Message enregistré:', msg);
    res.status(201).json({ message: 'Message saved', data: msg });
  } catch (err) {
    console.error('Erreur lors de l\'enregistrement du message:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/conversation/:friendId', authenticateToken, async (req, res) => {
  const friendId = parseInt(req.params.friendId, 10);
  const page = parseInt(req.query.page) || 0;
  const limit = parseInt(req.query.limit) || 50; // Augmenté à 50 messages par page
  
  try {
    const messages = await Message.find({
      $or: [
        { senderId: req.user.id, recipientId: friendId },
        { senderId: friendId, recipientId: req.user.id }
      ]
    })
      .populate('replyTo')
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean(); // Utilisation de lean() pour de meilleures performances

    // Ajouter le compte total des messages pour la pagination
    const totalMessages = await Message.countDocuments({
      $or: [
        { senderId: req.user.id, recipientId: friendId },
        { senderId: friendId, recipientId: req.user.id }
      ]
    });

    res.json({
      messages,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalMessages / limit),
        totalMessages
      }
    });
  } catch (err) {
    console.error('Erreur lors du chargement de la conversation:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/messages/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  
  try {
    const message = await Message.findById(id);
    
    if (!message) {
      return res.status(404).json({ error: 'Message non trouvé' });
    }
    
    if (message.senderId !== req.user.id) {
      return res.status(403).json({ error: 'Vous n\'êtes pas autorisé à modifier ce message' });
    }
    
    message.content = content;
    message.isEdited = true;
    await message.save();
    
    await message.populate('replyTo');
    io.emit('messageUpdated', message);
    
    res.json({ message: 'Message modifié', data: message });
  } catch (err) {
    console.error('Erreur lors de la modification du message:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    const message = await Message.findById(id);
    
    if (!message) {
      return res.status(404).json({ error: 'Message non trouvé' });
    }
    
    if (message.senderId !== req.user.id) {
      return res.status(403).json({ error: 'Vous n\'êtes pas autorisé à supprimer ce message' });
    }
    
    await message.deleteOne();
    io.emit('messageDeleted', { id });
    
    res.json({ message: 'Message supprimé' });
  } catch (err) {
    console.error('Erreur lors de la suppression du message:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages/:id/reactions', authenticateToken, async (req, res) => {
  const messageId = req.params.id;
  const { emoji } = req.body;
  const userId = req.user.id;

  console.log(`Ajout de réaction – messageId: ${messageId}, emoji: ${emoji}, user: ${userId}`);
  
  try {
    const message = await Message.findById(messageId);
    
    if (!message) {
      return res.status(404).json({ error: 'Message non trouvé' });
    }
    
    const reaction = message.reactions.find(r => r.emoji === emoji);
    if (reaction) {
      if (!reaction.users.includes(userId)) {
        reaction.count += 1;
        reaction.users.push(userId);
      }
    } else {
      message.reactions.push({
        emoji,
        count: 1,
        users: [userId]
      });
    }
    
    await message.save();
    io.emit('reactionAdded', {
      messageId,
      reactions: message.reactions
    });
    
    res.json({
      message: 'Réaction ajoutée',
      reactions: message.reactions
    });
  } catch (err) {
    console.error("Erreur lors de l'ajout de la réaction:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/messages/:id/reactions', authenticateToken, async (req, res) => {
  const messageId = req.params.id;
  const { emoji } = req.query;
  const userId = req.user.id;

  console.log(`Retrait de réaction – messageId: ${messageId}, emoji: ${emoji}, user: ${userId}`);

  try {
    const message = await Message.findById(messageId);
    
    if (!message) {
      return res.status(404).json({ error: 'Message non trouvé' });
    }
    
    const reaction = message.reactions.find(r => r.emoji === emoji);
    if (reaction && reaction.users.includes(userId)) {
      reaction.count -= 1;
      reaction.users = reaction.users.filter(u => u !== userId);
      
      if (reaction.count <= 0) {
        message.reactions = message.reactions.filter(r => r.emoji !== emoji);
      }
      
      await message.save();
      io.emit('reactionRemoved', {
        messageId,
        reactions: message.reactions
      });
      
      res.json({
        message: 'Réaction retirée',
        reactions: message.reactions
      });
    } else {
      res.status(400).json({ error: 'Aucune réaction trouvée pour cet emoji' });
    }
  } catch (err) {
    console.error("Erreur lors du retrait de la réaction:", err);
    res.status(500).json({ error: err.message });
  }
});

// Middleware de gestion des erreurs
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Une erreur interne est survenue'
  });
});

// Démarrage du serveur avec gestion d'erreur
server.listen(PORT, () => {
  console.log(`Messages service running on port ${PORT}`);
}).on('error', (err) => {
  console.error('Erreur lors du démarrage du serveur:', err);
  process.exit(1);
});

// Gestion des signaux d'arrêt
process.on('SIGTERM', () => {
  console.log('SIGTERM reçu. Arrêt gracieux...');
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT reçu. Arrêt gracieux...');
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (err) => {
  console.error('Erreur non capturée:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Rejet de promesse non géré:', reason);
  process.exit(1);
});