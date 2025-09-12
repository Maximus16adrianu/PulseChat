const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const archiver = require('archiver'); // You'll need to install this: npm install archiver

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3002;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '@adan.mal.16!:';
const MAX_ACTIVE_USERS = 100;
const FRIEND_REQUEST_COOLDOWN = 5 * 60 * 1000; // 5 minutes
const FIRST_MUTE_DURATION = 60 * 1000; // 1 minute
const ESCALATED_MUTE_DURATION = 60 * 60 * 1000; // 1 hour
const WARNING_RESET_TIME = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGE_LENGTH = 250; // Maximum message length in characters
const CALL_TIMEOUT = 60 * 1000; // 60 seconds for call to be answered

// WebRTC Configuration with STUN servers for NAT traversal
const WEBRTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Rate limiting for login attempts - 5 per minute
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 login attempts per minute per IP
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use('/api/register', loginLimiter);
app.use('/api/', apiLimiter);

// In-memory storage for active users and rate limiting
const activeUsers = new Map();
const messageLimits = new Map();
const uploadLimits = new Map();
const friendRequestCooldowns = new Map();
const activeCalls = new Map(); // Track ongoing calls

// Ensure directories exist
async function initializeDirectories() {
  const dirs = [
    'private',
    'private/messages',
    'private/messages/pictures',
    'private/messages/videos',
    'private/users',
    'private/friends',
    'private/logins',
    'private/mutes'
  ];
  
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        console.error(`Error creating directory ${dir}:`, error);
      }
    }
  }
  
  // Initialize JSON files if they don't exist
  const files = [
    'private/messages/messages.json',
    'private/users/users.json',
    'private/friends/friends.json',
    'private/logins/logins.json',
    'private/mutes/mutes.json'
  ];
  
  for (const file of files) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, JSON.stringify([], null, 2));
    }
  }
}

// File upload configuration - Using memory storage first for validation
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedImages = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const allowedVideos = ['video/mp4', 'video/webm', 'video/quicktime'];
  
  if (allowedImages.includes(file.mimetype) || allowedVideos.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// Helper functions
async function loadJSON(filename) {
  try {
    const data = await fs.readFile(filename, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

async function saveJSON(filename, data) {
  await fs.writeFile(filename, JSON.stringify(data, null, 2));
}

function generateUserId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateCallId() {
  return crypto.randomBytes(8).toString('hex');
}

function getUserTier(user) {
  if (['owner', 'admin', 'developer'].includes(user.role)) {
    return 3;
  }
  return user.tier || 1;
}

function isAdminOrOwner(user) {
  return ['admin', 'owner'].includes(user.role);
}

function isOwner(user) {
  return user.role === 'owner';
}

// Function to check if user1 can perform admin actions on user2
function canAdminAction(user1, user2) {
  if (!user1 || !user2) return false;
  
  // Owner can do anything to anyone
  if (user1.role === 'owner') return true;
  
  // Admin cannot perform actions on owner
  if (user1.role === 'admin' && user2.role === 'owner') return false;
  
  // Admin can perform actions on admin, developer, and user
  if (user1.role === 'admin' && ['admin', 'developer', 'user'].includes(user2.role)) return true;
  
  return false;
}

async function getUserById(userId) {
  const users = await loadJSON('private/users/users.json');
  return users.find(u => u.id === userId);
}

async function getUserByUsername(username) {
  const users = await loadJSON('private/users/users.json');
  return users.find(u => u.username === username);
}

async function getMessagesForUsers(user1Id, user2Id) {
  const messages = await loadJSON('private/messages/messages.json');
  return messages.filter(msg => 
    (msg.senderId === user1Id && msg.receiverId === user2Id) ||
    (msg.senderId === user2Id && msg.receiverId === user1Id)
  ).sort((a, b) => a.timestamp - b.timestamp);
}

async function deleteMessagesForUsers(user1Id, user2Id) {
  const messages = await loadJSON('private/messages/messages.json');
  
  // Get messages to delete (to also delete their files)
  const messagesToDelete = messages.filter(msg => 
    (msg.senderId === user1Id && msg.receiverId === user2Id) ||
    (msg.senderId === user2Id && msg.receiverId === user1Id)
  );
  
  // Delete actual files
  for (const message of messagesToDelete) {
    if (message.type === 'image' || message.type === 'video') {
      try {
        const filePath = message.type === 'image' 
          ? path.join(__dirname, 'private', 'messages', 'pictures', message.content)
          : path.join(__dirname, 'private', 'messages', 'videos', message.content);
        await fs.unlink(filePath);
        console.log(`Deleted file: ${filePath}`);
      } catch (error) {
        console.log(`Could not delete file ${message.content}:`, error.message);
      }
    }
  }
  
  // Filter out the messages
  const filteredMessages = messages.filter(msg => 
    !((msg.senderId === user1Id && msg.receiverId === user2Id) ||
      (msg.senderId === user2Id && msg.receiverId === user1Id))
  );
  
  await saveJSON('private/messages/messages.json', filteredMessages);
}

async function deleteMessageById(messageId) {
  const messages = await loadJSON('private/messages/messages.json');
  const messageIndex = messages.findIndex(msg => msg.id === messageId);
  
  if (messageIndex === -1) {
    return { success: false, error: 'Message not found' };
  }
  
  const message = messages[messageIndex];
  
  // Delete file if it's an image or video
  if (message.type === 'image' || message.type === 'video') {
    try {
      const filePath = message.type === 'image' 
        ? path.join(__dirname, 'private', 'messages', 'pictures', message.content)
        : path.join(__dirname, 'private', 'messages', 'videos', message.content);
      await fs.unlink(filePath);
      console.log(`Deleted file: ${filePath}`);
    } catch (error) {
      console.error(`Error deleting file ${message.content}:`, error);
      // Continue with message deletion even if file deletion fails
    }
  }
  
  // Remove message from array
  messages.splice(messageIndex, 1);
  await saveJSON('private/messages/messages.json', messages);
  
  return { success: true, message };
}

async function getFriendshipDetails(user1Id, user2Id) {
  const friends = await loadJSON('private/friends/friends.json');
  return friends.find(f => 
    ((f.user1 === user1Id && f.user2 === user2Id) ||
     (f.user1 === user2Id && f.user2 === user1Id)) &&
    f.status === 'accepted'
  );
}

// Session management
async function saveSession(token, userId) {
  const sessions = await loadJSON('private/logins/logins.json');
  sessions.push({
    token,
    userId,
    created: Date.now(),
    lastUsed: Date.now()
  });
  await saveJSON('private/logins/logins.json', sessions);
}

async function getSessionUserId(token) {
  const sessions = await loadJSON('private/logins/logins.json');
  const session = sessions.find(s => s.token === token);
  if (session) {
    // Update last used
    session.lastUsed = Date.now();
    await saveJSON('private/logins/logins.json', sessions);
    return session.userId;
  }
  return null;
}

async function deleteUserSessions(userId) {
  const sessions = await loadJSON('private/logins/logins.json');
  const filteredSessions = sessions.filter(s => s.userId !== userId);
  await saveJSON('private/logins/logins.json', filteredSessions);
}

async function cleanupOldSessions() {
  const sessions = await loadJSON('private/logins/logins.json');
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const activeSessions = sessions.filter(s => s.lastUsed > thirtyDaysAgo);
  await saveJSON('private/logins/logins.json', activeSessions);
}

// Mute management
async function saveMute(userId, muteEnd, reason, escalationLevel = 0) {
  const mutes = await loadJSON('private/mutes/mutes.json');
  const existingIndex = mutes.findIndex(m => m.userId === userId);
  
  const muteRecord = {
    userId,
    muteEnd,
    reason,
    escalationLevel,
    created: Date.now()
  };
  
  if (existingIndex !== -1) {
    mutes[existingIndex] = muteRecord;
  } else {
    mutes.push(muteRecord);
  }
  
  await saveJSON('private/mutes/mutes.json', mutes);
}

async function saveAdminMute(userId, muteEnd, reason) {
  const mutes = await loadJSON('private/mutes/mutes.json');
  const existingIndex = mutes.findIndex(m => m.userId === userId);
  
  const muteRecord = {
    userId,
    muteEnd,
    reason,
    adminMute: true,
    created: Date.now()
  };
  
  if (existingIndex !== -1) {
    mutes[existingIndex] = muteRecord;
  } else {
    mutes.push(muteRecord);
  }
  
  await saveJSON('private/mutes/mutes.json', mutes);
}

async function getUserMute(userId) {
  const mutes = await loadJSON('private/mutes/mutes.json');
  return mutes.find(m => m.userId === userId && m.muteEnd > Date.now());
}

async function removeMute(userId) {
  const mutes = await loadJSON('private/mutes/mutes.json');
  const filteredMutes = mutes.filter(m => m.userId !== userId);
  await saveJSON('private/mutes/mutes.json', filteredMutes);
}

async function cleanupExpiredMutes() {
  const mutes = await loadJSON('private/mutes/mutes.json');
  const now = Date.now();
  const activeMutes = mutes.filter(m => m.muteEnd > now);
  await saveJSON('private/mutes/mutes.json', activeMutes);
}

// Ban management
async function banUser(userId, reason = 'Banned by admin') {
  const users = await loadJSON('private/users/users.json');
  const userIndex = users.findIndex(u => u.id === userId);
  
  if (userIndex === -1) {
    return { success: false, error: 'User not found' };
  }
  
  users[userIndex].banned = true;
  users[userIndex].banReason = reason;
  users[userIndex].banDate = Date.now();
  
  await saveJSON('private/users/users.json', users);
  
  // Kick user if online
  const userConnection = Array.from(activeUsers.values()).find(u => u.user.id === userId);
  if (userConnection) {
    io.to(userConnection.socket).emit('banned', { reason });
    activeUsers.delete(userId);
  }
  
  return { success: true };
}

async function unbanUser(userId) {
  const users = await loadJSON('private/users/users.json');
  const userIndex = users.findIndex(u => u.id === userId);
  
  if (userIndex === -1) {
    return { success: false, error: 'User not found' };
  }
  
  users[userIndex].banned = false;
  delete users[userIndex].banReason;
  delete users[userIndex].banDate;
  
  await saveJSON('private/users/users.json', users);
  
  return { success: true };
}

// Call management functions
function isUserInCall(userId) {
  for (const [callId, call] of activeCalls) {
    if (call.callerId === userId || call.receiverId === userId) {
      return callId;
    }
  }
  return null;
}

function endCall(callId, reason = 'Call ended') {
  const call = activeCalls.get(callId);
  if (!call) return false;
  
  // Clear timeout if exists
  if (call.timeout) {
    clearTimeout(call.timeout);
  }
  
  // Notify both participants
  const callerSocket = getSocketByUserId(call.callerId);
  const receiverSocket = getSocketByUserId(call.receiverId);
  
  if (callerSocket) {
    callerSocket.emit('call_ended', { callId, reason });
  }
  
  if (receiverSocket) {
    receiverSocket.emit('call_ended', { callId, reason });
  }
  
  // Remove from active calls
  activeCalls.delete(callId);
  
  console.log(`Call ${callId} ended: ${reason}`);
  return true;
}

// Send updated user lists helper
async function sendUpdatedUserLists(socket, userId) {
  try {
    const friends = await loadJSON('private/friends/friends.json');
    
    // Update friends list
    const userFriends = friends.filter(f => 
      (f.user1 === userId || f.user2 === userId) && f.status === 'accepted'
    );
    
    const userFriendsWithDetails = await Promise.all(
      userFriends.map(async (friendship) => {
        const friendId = friendship.user1 === userId ? friendship.user2 : friendship.user1;
        const friendUser = await getUserById(friendId);
        
        // Check if friend is online and in a call
        const friendOnline = activeUsers.has(friendId);
        const friendInCall = isUserInCall(friendId);
        
        return {
          ...friendship,
          friendId,
          friendUsername: friendUser ? friendUser.username : 'Unknown User',
          friendRole: friendUser ? friendUser.role : 'user',
          friendTier: friendUser ? getUserTier(friendUser) : 1,
          friendsSince: friendship.acceptedAt || friendship.timestamp,
          online: friendOnline,
          inCall: !!friendInCall
        };
      })
    );
    
    // Update blocked list
    const blockedUsers = friends.filter(f => 
      f.status === 'blocked' && 
      (f.user1 === userId || f.user2 === userId) &&
      f.blockedBy === userId
    );
    
    const blockedUsersWithDetails = await Promise.all(
      blockedUsers.map(async (block) => {
        const blockedId = block.user1 === userId ? block.user2 : block.user1;
        const blockedUser = await getUserById(blockedId);
        return {
          ...block,
          blockedId,
          blockedUsername: blockedUser ? blockedUser.username : 'Unknown User'
        };
      })
    );
    
    socket.emit('friends_list', userFriendsWithDetails);
    socket.emit('blocked_users', blockedUsersWithDetails);
  } catch (error) {
    console.error('Error sending updated user lists:', error);
  }
}

// Helper function to get socket by user ID
function getSocketByUserId(userId) {
  const userConnection = Array.from(activeUsers.values()).find(u => u.user.id === userId);
  return userConnection ? io.sockets.sockets.get(userConnection.socket) : null;
}

// Rate limiting functions
function checkMessageLimit(userId) {
  const now = Date.now();
  if (!messageLimits.has(userId)) {
    messageLimits.set(userId, { 
      messages: [], 
      warnings: [], 
      lastMessage: 0,
      warningsResetTime: 0,
      escalationLevel: 0
    });
  }
  
  const userLimits = messageLimits.get(userId);
  
  // Check 2-second gap between messages
  if (now - userLimits.lastMessage < 2000) {
    return { allowed: false, reason: 'Please wait 2 seconds between messages' };
  }
  
  // Clean old messages (older than 30 seconds)
  userLimits.messages = userLimits.messages.filter(time => now - time < 30000);
  
  // Check if warnings should be reset (5 minutes of good behavior)
  if (userLimits.warningsResetTime > 0 && now - userLimits.warningsResetTime > WARNING_RESET_TIME) {
    userLimits.warnings = [];
    userLimits.warningsResetTime = 0;
    userLimits.escalationLevel = 0;
  }
  
  // Check 5 messages in 30 seconds
  if (userLimits.messages.length >= 5) {
    // Add warning
    userLimits.warnings.push(now);
    
    // If this is the first warning after a reset, start the reset timer
    if (userLimits.warnings.length === 1) {
      userLimits.warningsResetTime = now;
    }
    
    // Check if user should be muted (3 warnings)
    if (userLimits.warnings.length >= 3) {
      const muteLevel = userLimits.escalationLevel;
      let muteDuration, reason;
      
      if (muteLevel === 0) {
        // First time reaching 3 warnings
        muteDuration = FIRST_MUTE_DURATION;
        reason = 'First spam mute (1 minute)';
        userLimits.escalationLevel = 1;
      } else {
        // Escalated mute
        muteDuration = ESCALATED_MUTE_DURATION;
        reason = 'Repeated spam violation (1 hour)';
      }
      
      const muteEnd = now + muteDuration;
      saveMute(userId, muteEnd, reason, userLimits.escalationLevel);
      
      // Reset warnings and messages
      userLimits.warnings = [];
      userLimits.messages = [];
      userLimits.warningsResetTime = 0;
      
      const minutes = Math.ceil(muteDuration / 60000);
      return { 
        allowed: false, 
        reason: `You have been muted for ${minutes === 1 ? '1 minute' : minutes === 60 ? '1 hour' : minutes + ' minutes'} due to excessive messaging` 
      };
    }
    
    return { allowed: false, reason: 'Chill out! You\'re sending messages too quickly' };
  }
  
  userLimits.messages.push(now);
  userLimits.lastMessage = now;
  return { allowed: true };
}

function checkUploadLimit(userId, isVideo = false, userRole = 'user') {
  // Owner has no upload limits
  if (userRole === 'owner') {
    return { allowed: true };
  }
  
  const now = Date.now();
  if (!uploadLimits.has(userId)) {
    uploadLimits.set(userId, { uploads: [], dailyUploads: [] });
  }
  
  const userLimits = uploadLimits.get(userId);
  
  // Clean old uploads
  userLimits.uploads = userLimits.uploads.filter(time => now - time < 60000); // 1 minute
  userLimits.dailyUploads = userLimits.dailyUploads.filter(time => now - time < 86400000); // 24 hours
  
  // Check daily limit (5 per day)
  if (userLimits.dailyUploads.length >= 5) {
    return { allowed: false, reason: 'Daily upload limit reached (5 files per day)' };
  }
  
  // Check 30-minute limit (3 files)
  const recent30min = userLimits.uploads.filter(time => now - time < 1800000);
  if (recent30min.length >= 3) {
    return { allowed: false, reason: 'Upload limit reached (3 files per 30 minutes)' };
  }
  
  // Check 1-minute limit (1 file)
  if (userLimits.uploads.length >= 1) {
    return { allowed: false, reason: 'Please wait 1 minute between uploads' };
  }
  
  userLimits.uploads.push(now);
  userLimits.dailyUploads.push(now);
  return { allowed: true };
}

function checkFriendRequestCooldown(userId) {
  const now = Date.now();
  if (friendRequestCooldowns.has(userId)) {
    const lastRequest = friendRequestCooldowns.get(userId);
    const timeLeft = FRIEND_REQUEST_COOLDOWN - (now - lastRequest);
    if (timeLeft > 0) {
      const minutesLeft = Math.ceil(timeLeft / 60000);
      return { allowed: false, reason: `Please wait ${minutesLeft} minute(s) before sending another friend request` };
    }
  }
  return { allowed: true };
}

async function isUserMuted(userId) {
  const mute = await getUserMute(userId);
  return mute !== undefined;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('authenticate', async (data) => {
    try {
      const { username, password, sessionToken } = data;
      let user = null;
      
      // Try session token first
      if (sessionToken) {
        const userId = await getSessionUserId(sessionToken);
        if (userId) {
          user = await getUserById(userId);
        }
      }
      
      // If no valid session, try username/password
      if (!user && username && password) {
        const users = await loadJSON('private/users/users.json');
        user = users.find(u => u.username === username && u.password === password);
        
        if (user) {
          // Create new session
          const token = generateSessionToken();
          await saveSession(token, user.id);
          socket.emit('session_token', token);
        }
      }
      
      if (!user) {
        socket.emit('auth_error', 'Invalid credentials');
        return;
      }
      
      if (user.banned) {
        socket.emit('auth_error', 'User is banned');
        return;
      }
      
      // Check active user limit - NO MORE QUEUE, just reject
      if (activeUsers.size >= MAX_ACTIVE_USERS && !activeUsers.has(user.id)) {
        socket.emit('auth_error', `Server is currently full (${MAX_ACTIVE_USERS}/${MAX_ACTIVE_USERS} users). Please try again later.`);
        return;
      }
      
      activeUsers.set(user.id, { socket: socket.id, lastActive: Date.now(), user });
      socket.userId = user.id;
      socket.emit('authenticated', { user: { ...user, password: undefined } });
      
      // Send WebRTC configuration to client
      socket.emit('webrtc_config', WEBRTC_CONFIG);
      
      // Load and send friends list with full user details (including call status)
      const friends = await loadJSON('private/friends/friends.json');
      const userFriends = friends.filter(f => 
        (f.user1 === user.id || f.user2 === user.id) && f.status === 'accepted'
      );
      
      // Populate friend details with call status
      const friendsWithDetails = await Promise.all(
        userFriends.map(async (friendship) => {
          const friendId = friendship.user1 === user.id ? friendship.user2 : friendship.user1;
          const friendUser = await getUserById(friendId);
          
          // Check if friend is online and in a call
          const friendOnline = activeUsers.has(friendId);
          const friendInCall = isUserInCall(friendId);
          
          return {
            ...friendship,
            friendId,
            friendUsername: friendUser ? friendUser.username : 'Unknown User',
            friendRole: friendUser ? friendUser.role : 'user',
            friendTier: friendUser ? getUserTier(friendUser) : 1,
            friendsSince: friendship.acceptedAt || friendship.timestamp,
            online: friendOnline,
            inCall: !!friendInCall
          };
        })
      );
      
      // Load pending friend requests
      const pendingRequests = friends.filter(f => 
        f.user2 === user.id && f.status === 'pending'
      );
      
      const requestsWithSenders = await Promise.all(
        pendingRequests.map(async (req) => {
          const sender = await getUserById(req.user1);
          return {
            ...req,
            senderUsername: sender ? sender.username : 'Unknown User'
          };
        })
      );
      
      // Load blocked users
      const blockedUsers = friends.filter(f => 
        f.status === 'blocked' && 
        (f.user1 === user.id || f.user2 === user.id) &&
        f.blockedBy === user.id
      );
      
      const blockedUsersWithDetails = await Promise.all(
        blockedUsers.map(async (block) => {
          const blockedId = block.user1 === user.id ? block.user2 : block.user1;
          const blockedUser = await getUserById(blockedId);
          return {
            ...block,
            blockedId,
            blockedUsername: blockedUser ? blockedUser.username : 'Unknown User'
          };
        })
      );
      
      socket.emit('friends_list', friendsWithDetails);
      socket.emit('friend_requests', requestsWithSenders);
      socket.emit('blocked_users', blockedUsersWithDetails);
      
      // Check if user was in a call before disconnecting
      const existingCallId = isUserInCall(user.id);
      if (existingCallId) {
        const call = activeCalls.get(existingCallId);
        if (call) {
          socket.emit('call_reconnected', {
            callId: existingCallId,
            otherUserId: call.callerId === user.id ? call.receiverId : call.callerId,
            status: call.status
          });
        }
      }
      
    } catch (error) {
      console.error('Authentication error:', error);
      socket.emit('auth_error', 'Server error');
    }
  });
  
  // WebRTC Calling Events
  socket.on('initiate_call', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { receiverId } = data;
      const caller = await getUserById(socket.userId);
      const receiver = await getUserById(receiverId);
      
      if (!caller || !receiver) {
        socket.emit('call_error', 'User not found');
        return;
      }
      
      // Calls are available to all users (no tier restriction)
      
      // Check if they are friends
      const friendship = await getFriendshipDetails(socket.userId, receiverId);
      if (!friendship) {
        socket.emit('call_error', 'Can only call friends');
        return;
      }
      
      // Check if receiver is online
      const receiverSocket = getSocketByUserId(receiverId);
      if (!receiverSocket) {
        socket.emit('call_error', 'User is not online');
        return;
      }
      
      // Check if either user is already in a call
      const callerInCall = isUserInCall(socket.userId);
      const receiverInCall = isUserInCall(receiverId);
      
      if (callerInCall) {
        socket.emit('call_error', 'You are already in a call');
        return;
      }
      
      if (receiverInCall) {
        socket.emit('call_error', 'User is already in a call');
        return;
      }
      
      // Create call record
      const callId = generateCallId();
      const call = {
        callId,
        callerId: socket.userId,
        receiverId,
        status: 'ringing',
        startTime: Date.now(),
        timeout: null,
        iceCandidates: { caller: [], receiver: [] } // Store ICE candidates
      };
      
      // Set timeout for call
      call.timeout = setTimeout(() => {
        endCall(callId, 'Call timeout - no answer');
      }, CALL_TIMEOUT);
      
      activeCalls.set(callId, call);
      
      // Notify receiver with WebRTC config
      receiverSocket.emit('incoming_call', {
        callId,
        callerId: socket.userId,
        callerUsername: caller.username,
        webrtcConfig: WEBRTC_CONFIG
      });
      
      // Notify caller
      socket.emit('call_initiated', {
        callId,
        receiverId,
        receiverUsername: receiver.username,
        webrtcConfig: WEBRTC_CONFIG
      });
      
      console.log(`Call initiated: ${caller.username} -> ${receiver.username} (${callId})`);
      
    } catch (error) {
      console.error('Initiate call error:', error);
      socket.emit('call_error', 'Failed to initiate call');
    }
  });
  
  socket.on('accept_call', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId } = data;
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call_error', 'Call not found');
        return;
      }
      
      if (call.receiverId !== socket.userId) {
        socket.emit('call_error', 'Not authorized to accept this call');
        return;
      }
      
      if (call.status !== 'ringing') {
        socket.emit('call_error', 'Call is no longer ringing');
        return;
      }
      
      // Clear timeout
      if (call.timeout) {
        clearTimeout(call.timeout);
        call.timeout = null;
      }
      
      // Update call status
      call.status = 'connecting';
      call.acceptTime = Date.now();
      
      // Notify both participants with WebRTC config
      const callerSocket = getSocketByUserId(call.callerId);
      
      if (callerSocket) {
        callerSocket.emit('call_accepted', { 
          callId,
          webrtcConfig: WEBRTC_CONFIG
        });
      }
      
      socket.emit('call_accepted', { 
        callId,
        webrtcConfig: WEBRTC_CONFIG
      });
      
      console.log(`Call accepted: ${callId}`);
      
    } catch (error) {
      console.error('Accept call error:', error);
      socket.emit('call_error', 'Failed to accept call');
    }
  });
  
  socket.on('decline_call', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId } = data;
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call_error', 'Call not found');
        return;
      }
      
      if (call.receiverId !== socket.userId) {
        socket.emit('call_error', 'Not authorized to decline this call');
        return;
      }
      
      endCall(callId, 'Call declined');
      
    } catch (error) {
      console.error('Decline call error:', error);
      socket.emit('call_error', 'Failed to decline call');
    }
  });
  
  socket.on('hang_up_call', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId } = data;
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call_error', 'Call not found');
        return;
      }
      
      if (call.callerId !== socket.userId && call.receiverId !== socket.userId) {
        socket.emit('call_error', 'Not authorized to hang up this call');
        return;
      }
      
      endCall(callId, 'Call ended by user');
      
    } catch (error) {
      console.error('Hang up call error:', error);
      socket.emit('call_error', 'Failed to hang up call');
    }
  });
  
  // WebRTC signaling events with improved ICE handling
  socket.on('webrtc_offer', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId, offer } = data;
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call_error', 'Call not found');
        return;
      }
      
      if (call.callerId !== socket.userId) {
        socket.emit('call_error', 'Only caller can send offer');
        return;
      }
      
      // Store the offer
      call.offer = offer;
      
      // Forward offer to receiver with WebRTC config
      const receiverSocket = getSocketByUserId(call.receiverId);
      if (receiverSocket) {
        receiverSocket.emit('webrtc_offer', { 
          callId, 
          offer,
          webrtcConfig: WEBRTC_CONFIG
        });
        
        // Send any stored ICE candidates from caller
        if (call.iceCandidates.caller.length > 0) {
          call.iceCandidates.caller.forEach(candidate => {
            receiverSocket.emit('webrtc_ice_candidate', { callId, candidate });
          });
        }
      }
      
    } catch (error) {
      console.error('WebRTC offer error:', error);
      socket.emit('call_error', 'Failed to send offer');
    }
  });
  
  socket.on('webrtc_answer', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId, answer } = data;
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call_error', 'Call not found');
        return;
      }
      
      if (call.receiverId !== socket.userId) {
        socket.emit('call_error', 'Only receiver can send answer');
        return;
      }
      
      // Update call status to connected
      call.status = 'connected';
      call.connectTime = Date.now();
      call.answer = answer;
      
      // Forward answer to caller
      const callerSocket = getSocketByUserId(call.callerId);
      if (callerSocket) {
        callerSocket.emit('webrtc_answer', { 
          callId, 
          answer,
          webrtcConfig: WEBRTC_CONFIG
        });
        
        // Send any stored ICE candidates from receiver
        if (call.iceCandidates.receiver.length > 0) {
          call.iceCandidates.receiver.forEach(candidate => {
            callerSocket.emit('webrtc_ice_candidate', { callId, candidate });
          });
        }
      }
      
      console.log(`Call connected: ${callId}`);
      
    } catch (error) {
      console.error('WebRTC answer error:', error);
      socket.emit('call_error', 'Failed to send answer');
    }
  });
  
  socket.on('webrtc_ice_candidate', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId, candidate } = data;
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call_error', 'Call not found');
        return;
      }
      
      if (call.callerId !== socket.userId && call.receiverId !== socket.userId) {
        socket.emit('call_error', 'Not authorized for this call');
        return;
      }
      
      const isCaller = call.callerId === socket.userId;
      const otherUserId = isCaller ? call.receiverId : call.callerId;
      const otherSocket = getSocketByUserId(otherUserId);
      
      // Store ICE candidate for later if needed
      if (isCaller) {
        call.iceCandidates.caller.push(candidate);
      } else {
        call.iceCandidates.receiver.push(candidate);
      }
      
      // Forward ICE candidate to the other participant immediately if they're ready
      if (otherSocket) {
        // Only send if the call has progressed far enough
        if ((isCaller && call.status === 'connecting' && call.answer) ||
            (!isCaller && call.status === 'connecting' && call.offer)) {
          otherSocket.emit('webrtc_ice_candidate', { callId, candidate });
        }
      }
      
    } catch (error) {
      console.error('WebRTC ICE candidate error:', error);
      socket.emit('call_error', 'Failed to send ICE candidate');
    }
  });
  
  // Add connection state monitoring
  socket.on('webrtc_connection_state', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId, state } = data;
      const call = activeCalls.get(callId);
      
      if (!call) return;
      
      if (call.callerId !== socket.userId && call.receiverId !== socket.userId) return;
      
      // Update call with connection state
      const isCaller = call.callerId === socket.userId;
      if (isCaller) {
        call.callerConnectionState = state;
      } else {
        call.receiverConnectionState = state;
      }
      
      // If connection failed, end the call
      if (state === 'failed' || state === 'disconnected') {
        setTimeout(() => {
          if (activeCalls.has(callId)) {
            endCall(callId, 'Connection lost');
          }
        }, 5000); // Give 5 seconds to reconnect
      }
      
      console.log(`Call ${callId} - ${isCaller ? 'Caller' : 'Receiver'} connection state: ${state}`);
      
    } catch (error) {
      console.error('WebRTC connection state error:', error);
    }
  });
  
  socket.on('load_messages', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { friendId } = data;
      const messages = await getMessagesForUsers(socket.userId, friendId);
      
      socket.emit('messages_loaded', { friendId, messages });
      
    } catch (error) {
      console.error('Load messages error:', error);
      socket.emit('message_error', 'Failed to load messages');
    }
  });
  
  socket.on('delete_message', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { messageId } = data;
      const currentUser = await getUserById(socket.userId);
      
      if (!currentUser) {
        socket.emit('message_error', 'User not found');
        return;
      }
      
      // Get the message first to check permissions
      const messages = await loadJSON('private/messages/messages.json');
      const message = messages.find(m => m.id === messageId);
      
      if (!message) {
        socket.emit('message_error', 'Message not found');
        return;
      }
      
      // Get the message sender to check their role
      const messageSender = await getUserById(message.senderId);
      
      // Check if user can delete this message
      let canDelete = false;
      
      if (message.senderId === socket.userId) {
        // Users can always delete their own messages
        canDelete = true;
      } else if (currentUser.role === 'owner') {
        // Owner can delete any message
        canDelete = true;
      } else if (currentUser.role === 'admin' && messageSender && messageSender.role !== 'owner') {
        // Admin can delete messages from non-owners
        canDelete = true;
      }
      
      if (!canDelete) {
        socket.emit('message_error', 'You do not have permission to delete this message');
        return;
      }
      
      // Delete the message
      const result = await deleteMessageById(messageId);
      
      if (result.success) {
        // Notify both users about the deletion
        const senderId = message.senderId;
        const receiverId = message.receiverId;
        
        const senderSocket = getSocketByUserId(senderId);
        const receiverSocket = getSocketByUserId(receiverId);
        
        if (senderSocket) {
          senderSocket.emit('message_deleted', { messageId });
        }
        
        if (receiverSocket && receiverId !== senderId) {
          receiverSocket.emit('message_deleted', { messageId });
        }
        
      } else {
        socket.emit('message_error', result.error);
      }
      
    } catch (error) {
      console.error('Delete message error:', error);
      socket.emit('message_error', 'Failed to delete message');
    }
  });
  
  socket.on('send_message', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { receiverId, content } = data;
      
      // Check if user is muted
      if (await isUserMuted(socket.userId)) {
        socket.emit('message_error', 'You are currently muted');
        return;
      }
      
      // Check message length limit
      if (!content || content.trim().length === 0) {
        socket.emit('message_error', 'Message cannot be empty');
        return;
      }
      
      if (content.length > MAX_MESSAGE_LENGTH) {
        socket.emit('message_error', `Message too long (${content.length}/${MAX_MESSAGE_LENGTH} characters)`);
        return;
      }
      
      // Check rate limits
      const limitCheck = checkMessageLimit(socket.userId);
      if (!limitCheck.allowed) {
        socket.emit('message_error', limitCheck.reason);
        return;
      }
      
      // Verify friendship and not blocked
      const friends = await loadJSON('private/friends/friends.json');
      const friendship = friends.find(f => 
        ((f.user1 === socket.userId && f.user2 === receiverId) ||
         (f.user1 === receiverId && f.user2 === socket.userId))
      );
      
      if (!friendship || friendship.status !== 'accepted') {
        socket.emit('message_error', 'Can only message friends');
        return;
      }
      
      // Save message
      const messages = await loadJSON('private/messages/messages.json');
      const message = {
        id: generateUserId(),
        senderId: socket.userId,
        receiverId,
        content,
        type: 'text',
        timestamp: Date.now()
      };
      
      messages.push(message);
      await saveJSON('private/messages/messages.json', messages);
      
      // Send to receiver if online
      const receiverSocket = getSocketByUserId(receiverId);
      if (receiverSocket) {
        receiverSocket.emit('new_message', message);
      }
      
      socket.emit('message_sent', message);
      
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('message_error', 'Failed to send message');
    }
  });
  
  socket.on('send_friend_request', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { username } = data;
      
      // Check friend request cooldown
      const cooldownCheck = checkFriendRequestCooldown(socket.userId);
      if (!cooldownCheck.allowed) {
        socket.emit('friend_request_error', cooldownCheck.reason);
        return;
      }
      
      const targetUser = await getUserByUsername(username);
      
      if (!targetUser) {
        socket.emit('friend_request_error', 'User not found');
        return;
      }
      
      if (targetUser.id === socket.userId) {
        socket.emit('friend_request_error', 'Cannot add yourself');
        return;
      }
      
      // Check if target user allows friend requests
      if (targetUser.settings && targetUser.settings.allowFriendRequests === false) {
        socket.emit('friend_request_error', 'This user is not accepting friend requests');
        return;
      }
      
      const friends = await loadJSON('private/friends/friends.json');
      
      // Check if already friends or request exists
      const existing = friends.find(f => 
        (f.user1 === socket.userId && f.user2 === targetUser.id) ||
        (f.user1 === targetUser.id && f.user2 === socket.userId)
      );
      
      if (existing) {
        if (existing.status === 'accepted') {
          socket.emit('friend_request_error', 'Already friends');
          return;
        } else if (existing.status === 'blocked') {
          socket.emit('friend_request_error', 'Cannot send friend request');
          return;
        } else if (existing.status === 'pending') {
          socket.emit('friend_request_error', 'Friend request already sent');
          return;
        }
      }
      
      // Set cooldown
      friendRequestCooldowns.set(socket.userId, Date.now());
      
      // Add friend request
      const friendRequest = {
        id: generateUserId(),
        user1: socket.userId,
        user2: targetUser.id,
        status: 'pending',
        timestamp: Date.now()
      };
      
      friends.push(friendRequest);
      await saveJSON('private/friends/friends.json', friends);
      
      // Notify target user if online
      const targetSocket = getSocketByUserId(targetUser.id);
      if (targetSocket) {
        const sender = await getUserById(socket.userId);
        const requestWithSender = {
          ...friendRequest,
          senderUsername: sender.username
        };
        targetSocket.emit('friend_request_received', requestWithSender);
      }
      
      socket.emit('friend_request_sent', friendRequest);
      
    } catch (error) {
      console.error('Friend request error:', error);
      socket.emit('friend_request_error', 'Failed to send friend request');
    }
  });
  
  socket.on('respond_friend_request', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { requestId, accept } = data;
      
      const friends = await loadJSON('private/friends/friends.json');
      const requestIndex = friends.findIndex(f => f.id === requestId && f.user2 === socket.userId);
      
      if (requestIndex === -1) {
        socket.emit('friend_request_error', 'Friend request not found');
        return;
      }
      
      const request = friends[requestIndex];
      
      if (accept) {
        friends[requestIndex].status = 'accepted';
        friends[requestIndex].acceptedAt = Date.now();
      } else {
        friends.splice(requestIndex, 1); // Remove the request
      }
      
      await saveJSON('private/friends/friends.json', friends);
      
      // Notify the sender if online
      const senderSocket = getSocketByUserId(request.user1);
      if (senderSocket) {
        if (accept) {
          const accepter = await getUserById(socket.userId);
          senderSocket.emit('friend_request_accepted', {
            username: accepter.username,
            userId: socket.userId
          });
          
          // Send updated friends list to sender
          await sendUpdatedUserLists(senderSocket, request.user1);
        }
      }
      
      if (accept) {
        // Send updated friends list to accepter
        await sendUpdatedUserLists(socket, socket.userId);
      }
      
      // Send updated pending requests
      const remainingRequests = friends.filter(f => 
        f.user2 === socket.userId && f.status === 'pending'
      );
      
      const requestsWithSenders = await Promise.all(
        remainingRequests.map(async (req) => {
          const sender = await getUserById(req.user1);
          return {
            ...req,
            senderUsername: sender ? sender.username : 'Unknown User'
          };
        })
      );
      
      socket.emit('friend_requests', requestsWithSenders);
      socket.emit('friend_request_response_sent', { accepted: accept });
      
    } catch (error) {
      console.error('Friend request response error:', error);
      socket.emit('friend_request_error', 'Failed to respond to friend request');
    }
  });
  
  socket.on('block_user', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { userId: targetUserId } = data;
      
      const friends = await loadJSON('private/friends/friends.json');
      
      // End any active call between these users
      for (const [callId, call] of activeCalls) {
        if ((call.callerId === socket.userId && call.receiverId === targetUserId) ||
            (call.callerId === targetUserId && call.receiverId === socket.userId)) {
          endCall(callId, 'Call ended due to user block');
          break;
        }
      }
      
      // Delete all messages between the users immediately (including files)
      await deleteMessagesForUsers(socket.userId, targetUserId);
      
      // Find existing relationship
      const relationshipIndex = friends.findIndex(f => 
        (f.user1 === socket.userId && f.user2 === targetUserId) ||
        (f.user1 === targetUserId && f.user2 === socket.userId)
      );
      
      if (relationshipIndex !== -1) {
        // Update existing relationship to blocked
        friends[relationshipIndex].status = 'blocked';
        friends[relationshipIndex].blockedBy = socket.userId;
        friends[relationshipIndex].blockedAt = Date.now();
      } else {
        // Create new blocked relationship
        const blockRecord = {
          id: generateUserId(),
          user1: socket.userId,
          user2: targetUserId,
          status: 'blocked',
          blockedBy: socket.userId,
          blockedAt: Date.now()
        };
        friends.push(blockRecord);
      }
      
      await saveJSON('private/friends/friends.json', friends);
      
      // Update friends list and blocked list
      await sendUpdatedUserLists(socket, socket.userId);
      
      socket.emit('user_blocked', { userId: targetUserId });
      
    } catch (error) {
      console.error('Block user error:', error);
      socket.emit('message_error', 'Failed to block user');
    }
  });
  
  socket.on('unblock_user', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { userId: targetUserId } = data;
      
      const friends = await loadJSON('private/friends/friends.json');
      
      // Remove block relationship where current user blocked the target
      const filteredFriends = friends.filter(f => 
        !((f.user1 === socket.userId && f.user2 === targetUserId) ||
          (f.user1 === targetUserId && f.user2 === socket.userId)) ||
        f.status !== 'blocked' ||
        f.blockedBy !== socket.userId
      );
      
      await saveJSON('private/friends/friends.json', filteredFriends);
      
      // Update blocked list
      const remainingBlocked = filteredFriends.filter(f => 
        f.status === 'blocked' && 
        (f.user1 === socket.userId || f.user2 === socket.userId) &&
        f.blockedBy === socket.userId
      );
      
      const blockedUsersWithDetails = await Promise.all(
        remainingBlocked.map(async (block) => {
          const blockedId = block.user1 === socket.userId ? block.user2 : block.user1;
          const blockedUser = await getUserById(blockedId);
          return {
            ...block,
            blockedId,
            blockedUsername: blockedUser ? blockedUser.username : 'Unknown User'
          };
        })
      );
      
      socket.emit('blocked_users', blockedUsersWithDetails);
      socket.emit('user_unblocked', { userId: targetUserId });
      
    } catch (error) {
      console.error('Unblock user error:', error);
      socket.emit('message_error', 'Failed to unblock user');
    }
  });
  
  socket.on('admin_mute_user', async (data) => {
    try {
      if (!socket.userId) return;
      
      const currentUser = await getUserById(socket.userId);
      if (!isAdminOrOwner(currentUser)) {
        socket.emit('message_error', 'You do not have permission to mute users');
        return;
      }
      
      const { userId, duration, reason } = data;
      const targetUser = await getUserById(userId);
      
      if (!targetUser) {
        socket.emit('message_error', 'User not found');
        return;
      }
      
      // Check if current user can perform admin actions on target user
      if (!canAdminAction(currentUser, targetUser)) {
        socket.emit('message_error', 'You do not have permission to mute this user');
        return;
      }
      
      // Parse duration
      let muteDuration;
      switch (duration) {
        case '1h':
          muteDuration = 60 * 60 * 1000; // 1 hour
          break;
        case '1d':
          muteDuration = 24 * 60 * 60 * 1000; // 1 day
          break;
        case '1w':
          muteDuration = 7 * 24 * 60 * 60 * 1000; // 1 week
          break;
        default:
          muteDuration = 60 * 60 * 1000; // default 1 hour
      }
      
      const muteEnd = Date.now() + muteDuration;
      await saveAdminMute(userId, muteEnd, reason || 'Muted by admin');
      
      // Notify target user if online
      const targetSocket = getSocketByUserId(userId);
      if (targetSocket) {
        targetSocket.emit('muted', { 
          reason: reason || 'Muted by admin',
          duration: duration,
          until: muteEnd
        });
      }
      
      socket.emit('user_muted', { userId, duration });
      
    } catch (error) {
      console.error('Admin mute error:', error);
      socket.emit('message_error', 'Failed to mute user');
    }
  });
  
  socket.on('admin_ban_user', async (data) => {
    try {
      if (!socket.userId) return;
      
      const currentUser = await getUserById(socket.userId);
      if (!isAdminOrOwner(currentUser)) {
        socket.emit('message_error', 'You do not have permission to ban users');
        return;
      }
      
      const { userId, reason } = data;
      const targetUser = await getUserById(userId);
      
      if (!targetUser) {
        socket.emit('message_error', 'User not found');
        return;
      }
      
      // Check if current user can perform admin actions on target user
      if (!canAdminAction(currentUser, targetUser)) {
        socket.emit('message_error', 'You do not have permission to ban this user');
        return;
      }
      
      const result = await banUser(userId, reason || 'Banned by admin');
      
      if (result.success) {
        socket.emit('user_banned', { userId });
      } else {
        socket.emit('message_error', result.error);
      }
      
    } catch (error) {
      console.error('Admin ban error:', error);
      socket.emit('message_error', 'Failed to ban user');
    }
  });
  
  socket.on('update_settings', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { allowFriendRequests } = data;
      
      const users = await loadJSON('private/users/users.json');
      const userIndex = users.findIndex(u => u.id === socket.userId);
      
      if (userIndex === -1) {
        socket.emit('settings_error', 'User not found');
        return;
      }
      
      if (!users[userIndex].settings) {
        users[userIndex].settings = {};
      }
      
      users[userIndex].settings.allowFriendRequests = allowFriendRequests;
      
      await saveJSON('private/users/users.json', users);
      
      socket.emit('settings_updated', { allowFriendRequests });
      
    } catch (error) {
      console.error('Settings update error:', error);
      socket.emit('settings_error', 'Failed to update settings');
    }
  });
  
  socket.on('logout', async () => {
    if (socket.userId) {
      // End any active calls for this user
      const callId = isUserInCall(socket.userId);
      if (callId) {
        endCall(callId, 'User logged out');
      }
      
      // Remove all sessions for this user
      await deleteUserSessions(socket.userId);
      
      activeUsers.delete(socket.userId);
      socket.userId = null;
    }
    
    socket.emit('logged_out');
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.userId) {
      // End any active calls for this user
      const callId = isUserInCall(socket.userId);
      if (callId) {
        endCall(callId, 'User disconnected');
      }
      
      activeUsers.delete(socket.userId);
    }
  });
});

// API Routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const users = await loadJSON('private/users/users.json');
    
    if (users.find(u => u.username === username)) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const user = {
      id: generateUserId(),
      username,
      password, // In production, hash this password!
      tier: 1,
      role: 'user',
      banned: false,
      created: Date.now(),
      settings: {
        allowFriendRequests: true
      }
    };
    
    users.push(user);
    await saveJSON('private/users/users.json', users);
    
    res.json({ message: 'User registered successfully', userId: user.id });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fixed upload endpoint that validates BEFORE saving files
app.post('/api/upload', upload.single('file'), async (req, res) => {
  let savedFilePath = null;
  
  try {
    if (!req.body.userId || !req.body.receiverId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const userId = req.body.userId;
    const receiverId = req.body.receiverId;
    
    // Check user tier
    const users = await loadJSON('private/users/users.json');
    const user = users.find(u => u.id === userId);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid user' });
    }
    
    const userTier = getUserTier(user);
    const isVideo = req.file.mimetype.startsWith('video/');
    
    // Owner bypasses all tier restrictions
    if (user.role !== 'owner') {
      if (userTier < 2) {
        return res.status(403).json({ error: 'Insufficient tier for file uploads (Need Tier 2+)' });
      }
      
      if (isVideo && userTier < 3) {
        return res.status(403).json({ error: 'Insufficient tier for video uploads (Need Tier 3)' });
      }
    }
    
    // Check if user is muted
    if (await isUserMuted(userId)) {
      return res.status(403).json({ error: 'You are currently muted' });
    }
    
    // Check upload limits (owners bypass this)
    const limitCheck = checkUploadLimit(userId, isVideo, user.role);
    if (!limitCheck.allowed) {
      return res.status(429).json({ error: limitCheck.reason });
    }
    
    // Verify friendship
    const friends = await loadJSON('private/friends/friends.json');
    const friendship = friends.find(f => 
      ((f.user1 === userId && f.user2 === receiverId) ||
       (f.user1 === receiverId && f.user2 === userId)) &&
      f.status === 'accepted'
    );
    
    if (!friendship) {
      return res.status(403).json({ error: 'Can only send files to friends' });
    }
    
    // All validations passed, now save the file to disk
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const filename = uniqueSuffix + path.extname(req.file.originalname);
    const dir = isVideo ? 'private/messages/videos/' : 'private/messages/pictures/';
    savedFilePath = path.join(__dirname, dir, filename);
    
    await fs.writeFile(savedFilePath, req.file.buffer);
    
    // Save message record
    const messages = await loadJSON('private/messages/messages.json');
    const message = {
      id: generateUserId(),
      senderId: userId,
      receiverId,
      content: filename,
      type: isVideo ? 'video' : 'image',
      timestamp: Date.now()
    };
    
    messages.push(message);
    await saveJSON('private/messages/messages.json', messages);
    
    // Send real-time message to both sender and receiver
    const senderSocket = getSocketByUserId(userId);
    const receiverSocket = getSocketByUserId(receiverId);
    
    if (senderSocket) {
      senderSocket.emit('message_sent', message);
    }
    
    if (receiverSocket) {
      receiverSocket.emit('new_message', message);
    }
    
    res.json({ message: 'File uploaded successfully', messageId: message.id });
    
  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up saved file if there was an error after saving
    if (savedFilePath) {
      try {
        await fs.unlink(savedFilePath);
        console.log('Cleaned up failed upload file:', savedFilePath);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
    
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Serve media files
app.get('/api/media/:filename', async (req, res) => {
  const filename = req.params.filename;
  const imagePath = path.join(__dirname, 'private', 'messages', 'pictures', filename);
  const videoPath = path.join(__dirname, 'private', 'messages', 'videos', filename);
  
  try {
    // Try image path first
    await fs.access(imagePath);
    res.sendFile(imagePath);
  } catch {
    try {
      // Then try video path
      await fs.access(videoPath);
      res.sendFile(videoPath);
    } catch {
      res.status(404).send('File not found');
    }
  }
});

// Admin API Routes
app.use('/api/admin', (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await loadJSON('private/users/users.json');
    const mutes = await loadJSON('private/mutes/mutes.json');
    
    // Add mute status to users
    const usersWithMuteStatus = users.map(user => {
      const activeMute = mutes.find(m => m.userId === user.id && m.muteEnd > Date.now());
      const inCall = isUserInCall(user.id);
      
      return {
        ...user,
        password: undefined, // Don't send passwords
        muted: !!activeMute,
        muteEnd: activeMute ? activeMute.muteEnd : null,
        muteReason: activeMute ? activeMute.reason : null,
        online: activeUsers.has(user.id),
        inCall: !!inCall
      };
    });
    
    res.json(usersWithMuteStatus);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users/:userId/role', async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;
    
    const validRoles = ['user', 'developer', 'admin', 'owner'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    const users = await loadJSON('private/users/users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    users[userIndex].role = role;
    await saveJSON('private/users/users.json', users);
    
    res.json({ message: 'Role updated successfully' });
    
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users/:userId/tier', async (req, res) => {
  try {
    const { userId } = req.params;
    const { tier } = req.body;
    
    if (tier < 1 || tier > 3) {
      return res.status(400).json({ error: 'Invalid tier (must be 1, 2, or 3)' });
    }
    
    const users = await loadJSON('private/users/users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    users[userIndex].tier = tier;
    await saveJSON('private/users/users.json', users);
    
    res.json({ message: 'Tier updated successfully' });
    
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users/:userId/ban', async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    
    // Get target user to check if they are owner
    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Only API can ban owners (not socket-based admin actions)
    // This allows owners to be banned via API but not through normal admin interface
    
    const result = await banUser(userId, reason);
    
    if (result.success) {
      res.json({ message: 'User banned successfully' });
    } else {
      res.status(400).json({ error: result.error });
    }
    
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users/:userId/unban', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await unbanUser(userId);
    
    if (result.success) {
      res.json({ message: 'User unbanned successfully' });
    } else {
      res.status(400).json({ error: result.error });
    }
    
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users/:userId/mute', async (req, res) => {
  try {
    const { userId } = req.params;
    const { duration, reason } = req.body;
    
    // Get target user to check permissions
    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // API can mute anyone, but let's still respect the hierarchy for consistency
    // Parse duration
    let muteDuration;
    switch (duration) {
      case '1h':
        muteDuration = 60 * 60 * 1000; // 1 hour
        break;
      case '1d':
        muteDuration = 24 * 60 * 60 * 1000; // 1 day
        break;
      case '1w':
        muteDuration = 7 * 24 * 60 * 60 * 1000; // 1 week
        break;
      default:
        muteDuration = 60 * 60 * 1000; // default 1 hour
    }
    
    const muteEnd = Date.now() + muteDuration;
    await saveAdminMute(userId, muteEnd, reason || 'Muted by admin');
    
    // Notify target user if online
    const targetSocket = getSocketByUserId(userId);
    if (targetSocket) {
      targetSocket.emit('muted', { 
        reason: reason || 'Muted by admin',
        duration: duration,
        until: muteEnd
      });
    }
    
    res.json({ message: 'User muted successfully' });
    
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users/:userId/unmute', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const users = await loadJSON('private/users/users.json');
    const user = users.find(u => u.id === userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    await removeMute(userId);
    
    // Notify target user if online
    const targetSocket = getSocketByUserId(userId);
    if (targetSocket) {
      targetSocket.emit('unmuted', { message: 'You have been unmuted' });
    }
    
    res.json({ message: 'User unmuted successfully' });
    
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/backup', async (req, res) => {
  try {
    const archiveName = `pulsechat-backup-${new Date().toISOString().split('T')[0]}.zip`;
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);
    
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });
    
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      res.status(500).json({ error: 'Failed to create backup' });
    });
    
    // Pipe archive data to the response
    archive.pipe(res);
    
    // Add the entire private directory to the archive
    archive.directory('private/', false);
    
    // Finalize the archive
    await archive.finalize();
    
  } catch (error) {
    console.error('Backup error:', error);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const mutes = await loadJSON('private/mutes/mutes.json');
    const activeMutes = mutes.filter(m => m.muteEnd > Date.now());
    
    res.json({
      activeUsers: activeUsers.size,
      maxUsers: MAX_ACTIVE_USERS,
      mutedUsers: activeMutes.length,
      activeCalls: activeCalls.size
    });
  } catch (error) {
    res.json({
      activeUsers: activeUsers.size,
      maxUsers: MAX_ACTIVE_USERS,
      mutedUsers: 0,
      activeCalls: activeCalls.size
    });
  }
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Cleanup routines
setInterval(async () => {
  await cleanupOldSessions();
  await cleanupExpiredMutes();
  
  // Clean up expired calls (should not happen normally, but just in case)
  const now = Date.now();
  for (const [callId, call] of activeCalls) {
    if (now - call.startTime > 5 * 60 * 1000) { // 5 minutes max
      endCall(callId, 'Call timeout - cleanup');
    }
  }
}, 60 * 60 * 1000); // Run every hour

// Initialize and start server
async function start() {
  await initializeDirectories();
  
  server.listen(PORT, () => {
    console.log(`PulseChat server running on port ${PORT}`);
    console.log(`Admin API key: ${ADMIN_API_KEY}`);
    console.log(`Max active users: ${MAX_ACTIVE_USERS}`);
    console.log(`WebRTC calling enabled with proper STUN server configuration`);
  });
}

start();