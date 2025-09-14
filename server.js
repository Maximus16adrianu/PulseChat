const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const archiver = require('archiver');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  maxHttpBufferSize: 1e8, // 100MB for audio chunks
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3002;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '@adan.mal.16!:';
const MAX_ACTIVE_USERS = 100;
const FRIEND_REQUEST_COOLDOWN = 5 * 60 * 1000; // 5 minutes
const FIRST_MUTE_DURATION = 60 * 1000; // 1 minute
const ESCALATED_MUTE_DURATION = 60 * 60 * 1000; // 1 hour
const WARNING_RESET_TIME = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGE_LENGTH = 250;
const MESSAGE_RETENTION_TIME = 48 * 60 * 60 * 1000; // 48 hours
const MAX_MESSAGES_PER_CHAT = 250;

// Updated call time limits per week (in milliseconds) - Server-relayed audio
const CALL_TIME_LIMITS = {
  1: 5 * 60 * 60 * 1000,  // Tier 1: 5 hours
  2: 10 * 60 * 60 * 1000, // Tier 2: 10 hours 
  3: 15 * 60 * 60 * 1000, // Tier 3: 15 hours
  developer: 15 * 60 * 60 * 1000, // Developer: 15 hours
  admin: -1, // Unlimited
  owner: -1  // Unlimited
};

// Audio streaming constants (32kbps server-relayed)
const AUDIO_SAMPLE_RATE = 16000; // 16kHz
const AUDIO_BITRATE = 32000; // 32kbps
const AUDIO_CHUNK_SIZE = 1024; // bytes per chunk
const AUDIO_CHUNK_INTERVAL = 20; // ms between chunks

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});

app.use('/api/register', loginLimiter);
app.use('/api/', apiLimiter);

// In-memory storage
const activeUsers = new Map();
const messageLimits = new Map();
const uploadLimits = new Map();
const friendRequestCooldowns = new Map();

// Server-relayed voice calling state management
const activeCalls = new Map(); // callId -> { caller, receiver, startTime, answeredTime, status }
const userCalls = new Map();   // userId -> callId (only when actually in call)
const callTimeTracking = new Map(); // callId -> { startTime, lastUpdate }
const audioStreams = new Map(); // callId -> { callerStream: Buffer[], receiverStream: Buffer[] }

// Initialize directories
async function initializeDirectories() {
  const dirs = [
    'private', 'private/messages', 'private/messages/chats',
    'private/messages/pictures', 'private/messages/videos',
    'private/users', 'private/friends', 'private/logins',
    'private/mutes', 'private/calls'
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
  
  const files = [
    'private/messages/chats.json', 'private/users/users.json',
    'private/friends/friends.json', 'private/logins/logins.json',
    'private/mutes/mutes.json', 'private/calls/calls.json'
  ];
  
  for (const file of files) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, JSON.stringify([], null, 2));
    }
  }
}

// Dynamic week calculation functions - bulletproof after server restarts
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function getCurrentDynamicWeek() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12
  const dayOfMonth = now.getDate(); // 1-31
  
  const daysInMonth = getDaysInMonth(year, month);
  const daysPerWeek = daysInMonth / 4; // Dynamic week length
  
  const currentWeek = Math.ceil(dayOfMonth / daysPerWeek);
  
  return {
    year,
    month,
    week: Math.min(currentWeek, 4), // Cap at week 4
    daysInMonth,
    daysPerWeek: Math.round(daysPerWeek * 100) / 100 // Round to 2 decimals
  };
}

function getCurrentMonth() {
  return new Date().getMonth() + 1;
}

function getCurrentYear() {
  return new Date().getFullYear();
}

// Call time management with dynamic weeks
async function getUserCallTimeData(userId) {
  const callData = await loadJSON('private/calls/calls.json');
  const currentPeriod = getCurrentDynamicWeek();
  
  let userRecord = callData.find(record => record.userId === userId);
  
  if (!userRecord) {
    userRecord = {
      userId,
      week: currentPeriod.week,
      month: currentPeriod.month,
      year: currentPeriod.year,
      timeUsed: 0,
      lastReset: Date.now()
    };
    callData.push(userRecord);
    await saveJSON('private/calls/calls.json', callData);
  }
  
  // Reset if we're in a new week/month/year (bulletproof calculation)
  const needsReset = (
    userRecord.week !== currentPeriod.week ||
    userRecord.month !== currentPeriod.month ||
    userRecord.year !== currentPeriod.year
  );
  
  if (needsReset) {
    console.log(`Resetting call time for user ${userId}: Week ${userRecord.week}->${currentPeriod.week}, Month ${userRecord.month}->${currentPeriod.month}`);
    
    userRecord.week = currentPeriod.week;
    userRecord.month = currentPeriod.month;
    userRecord.year = currentPeriod.year;
    userRecord.timeUsed = 0;
    userRecord.lastReset = Date.now();
    
    await saveJSON('private/calls/calls.json', callData);
  }
  
  return userRecord;
}

async function updateUserCallTime(userId, timeToAdd) {
  const callData = await loadJSON('private/calls/calls.json');
  const userRecord = await getUserCallTimeData(userId);
  
  userRecord.timeUsed += timeToAdd;
  
  const recordIndex = callData.findIndex(record => record.userId === userId);
  if (recordIndex !== -1) {
    callData[recordIndex] = userRecord;
  }
  
  await saveJSON('private/calls/calls.json', callData);
  return userRecord.timeUsed;
}

async function getUserRemainingCallTime(userId) {
  const user = await getUserById(userId);
  if (!user) return 0;
  
  // Unlimited for admins and owners
  if (user.role === 'admin' || user.role === 'owner') {
    return -1; // Unlimited
  }
  
  // Get time limit based on tier/role
  let timeLimit;
  if (user.role === 'developer') {
    timeLimit = CALL_TIME_LIMITS.developer;
  } else {
    const tier = getUserTier(user);
    timeLimit = CALL_TIME_LIMITS[tier];
  }
  
  const userRecord = await getUserCallTimeData(userId);
  const remainingTime = timeLimit - userRecord.timeUsed;
  
  return Math.max(0, remainingTime);
}

async function canUserStartCall(userId) {
  const remainingTime = await getUserRemainingCallTime(userId);
  return remainingTime === -1 || remainingTime > 0;
}

// File upload configuration
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

function canAdminAction(user1, user2) {
  if (!user1 || !user2) return false;
  
  if (user1.role === 'owner') return true;
  
  if (user1.role === 'admin' && user2.role === 'owner') return false;
  
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

function generateChatId(user1Id, user2Id) {
  const sortedIds = [user1Id, user2Id].sort();
  return `${sortedIds[0]}_${sortedIds[1]}`;
}

// Chat management functions (same as before - keeping existing functionality)
async function getChatInfo(chatId) {
  const chats = await loadJSON('private/messages/chats.json');
  return chats.find(chat => chat.id === chatId);
}

async function createChat(user1Id, user2Id) {
  const chatId = generateChatId(user1Id, user2Id);
  const chats = await loadJSON('private/messages/chats.json');
  
  const existingChat = chats.find(chat => chat.id === chatId);
  if (existingChat) {
    return existingChat;
  }
  
  const newChat = {
    id: chatId,
    participants: [user1Id, user2Id],
    created: Date.now(),
    lastMessage: Date.now()
  };
  
  chats.push(newChat);
  await saveJSON('private/messages/chats.json', chats);
  
  const chatDir = path.join(__dirname, 'private', 'messages', 'chats', chatId);
  await fs.mkdir(chatDir, { recursive: true });
  
  const chatFile = path.join(chatDir, `${chatId}.json`);
  await fs.writeFile(chatFile, JSON.stringify([], null, 2));
  
  return newChat;
}

async function getMessagesForUsers(user1Id, user2Id) {
  const chatId = generateChatId(user1Id, user2Id);
  const chatFile = path.join(__dirname, 'private', 'messages', 'chats', chatId, `${chatId}.json`);
  
  try {
    const data = await fs.readFile(chatFile, 'utf8');
    const messages = JSON.parse(data);
    
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  } catch (error) {
    return [];
  }
}

// Message cleanup functions (same as before)
async function cleanupOldMessages() {
  console.log('Starting message cleanup...');
  const now = Date.now();
  const cutoffTime = now - MESSAGE_RETENTION_TIME;
  let totalDeleted = 0;
  let filesDeleted = 0;
  
  try {
    const chats = await loadJSON('private/messages/chats.json');
    
    for (const chat of chats) {
      const chatFile = path.join(__dirname, 'private', 'messages', 'chats', chat.id, `${chat.id}.json`);
      
      try {
        const data = await fs.readFile(chatFile, 'utf8');
        const messages = JSON.parse(data);
        const initialCount = messages.length;
        
        const messagesToDelete = messages.filter(msg => msg.timestamp < cutoffTime);
        let messagesToKeep = messages.filter(msg => msg.timestamp >= cutoffTime);
        
        for (const message of messagesToDelete) {
          if (message.type === 'image' || message.type === 'video') {
            try {
              const filePath = message.type === 'image' 
                ? path.join(__dirname, 'private', 'messages', 'pictures', message.content)
                : path.join(__dirname, 'private', 'messages', 'videos', message.content);
              await fs.unlink(filePath);
              filesDeleted++;
            } catch (error) {
              console.log(`Could not delete media file ${message.content}: ${error.message}`);
            }
          }
        }
        
        if (messagesToKeep.length > MAX_MESSAGES_PER_CHAT) {
          messagesToKeep.sort((a, b) => b.timestamp - a.timestamp);
          const excessMessages = messagesToKeep.slice(MAX_MESSAGES_PER_CHAT);
          messagesToKeep = messagesToKeep.slice(0, MAX_MESSAGES_PER_CHAT);
          
          for (const message of excessMessages) {
            if (message.type === 'image' || message.type === 'video') {
              try {
                const filePath = message.type === 'image' 
                  ? path.join(__dirname, 'private', 'messages', 'pictures', message.content)
                  : path.join(__dirname, 'private', 'messages', 'videos', message.content);
                await fs.unlink(filePath);
                filesDeleted++;
              } catch (error) {
                console.log(`Could not delete excess media file ${message.content}: ${error.message}`);
              }
            }
          }
        }
        
        if (messagesToKeep.length !== initialCount) {
          await fs.writeFile(chatFile, JSON.stringify(messagesToKeep, null, 2));
          const deletedCount = initialCount - messagesToKeep.length;
          totalDeleted += deletedCount;
          
          if (deletedCount > 0) {
            console.log(`Chat ${chat.id}: Deleted ${deletedCount} old messages (${initialCount} -> ${messagesToKeep.length})`);
          }
        }
        
      } catch (error) {
        console.error(`Error cleaning chat ${chat.id}:`, error);
      }
    }
    
    console.log(`Message cleanup completed: ${totalDeleted} messages deleted, ${filesDeleted} media files deleted`);
    
  } catch (error) {
    console.error('Error during message cleanup:', error);
  }
}

async function cleanupOrphanedMediaFiles() {
  console.log('Starting orphaned media cleanup...');
  let orphanedFiles = 0;
  
  try {
    const chats = await loadJSON('private/messages/chats.json');
    const referencedFiles = new Set();
    
    for (const chat of chats) {
      try {
        const messages = await getMessagesForUsers(chat.participants[0], chat.participants[1]);
        for (const message of messages) {
          if (message.type === 'image' || message.type === 'video') {
            referencedFiles.add(message.content);
          }
        }
      } catch (error) {
        console.error(`Error checking chat ${chat.id} for media references:`, error);
      }
    }
    
    try {
      const pictureFiles = await fs.readdir(path.join(__dirname, 'private', 'messages', 'pictures'));
      for (const file of pictureFiles) {
        if (!referencedFiles.has(file)) {
          try {
            await fs.unlink(path.join(__dirname, 'private', 'messages', 'pictures', file));
            orphanedFiles++;
            console.log(`Deleted orphaned picture: ${file}`);
          } catch (error) {
            console.error(`Error deleting orphaned picture ${file}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error reading pictures directory:', error);
    }
    
    try {
      const videoFiles = await fs.readdir(path.join(__dirname, 'private', 'messages', 'videos'));
      for (const file of videoFiles) {
        if (!referencedFiles.has(file)) {
          try {
            await fs.unlink(path.join(__dirname, 'private', 'messages', 'videos', file));
            orphanedFiles++;
            console.log(`Deleted orphaned video: ${file}`);
          } catch (error) {
            console.error(`Error deleting orphaned video ${file}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error reading videos directory:', error);
    }
    
    console.log(`Orphaned media cleanup completed: ${orphanedFiles} files deleted`);
    
  } catch (error) {
    console.error('Error during orphaned media cleanup:', error);
  }
}

async function saveMessageToChat(user1Id, user2Id, message) {
  const chatId = generateChatId(user1Id, user2Id);
  
  await createChat(user1Id, user2Id);
  
  const messages = await getMessagesForUsers(user1Id, user2Id);
  
  messages.push(message);
  
  messages.sort((a, b) => a.timestamp - b.timestamp);
  
  let finalMessages = messages;
  if (messages.length > MAX_MESSAGES_PER_CHAT) {
    const excessMessages = messages.slice(0, messages.length - MAX_MESSAGES_PER_CHAT);
    finalMessages = messages.slice(-MAX_MESSAGES_PER_CHAT);
    
    for (const oldMessage of excessMessages) {
      if (oldMessage.type === 'image' || oldMessage.type === 'video') {
        try {
          const filePath = oldMessage.type === 'image' 
            ? path.join(__dirname, 'private', 'messages', 'pictures', oldMessage.content)
            : path.join(__dirname, 'private', 'messages', 'videos', oldMessage.content);
          await fs.unlink(filePath);
          console.log(`Deleted excess message file: ${filePath}`);
        } catch (error) {
          console.log(`Could not delete excess file ${oldMessage.content}:`, error.message);
        }
      }
    }
  }
  
  const chatFile = path.join(__dirname, 'private', 'messages', 'chats', chatId, `${chatId}.json`);
  await fs.writeFile(chatFile, JSON.stringify(finalMessages, null, 2));
  
  const chats = await loadJSON('private/messages/chats.json');
  const chatIndex = chats.findIndex(chat => chat.id === chatId);
  if (chatIndex !== -1) {
    chats[chatIndex].lastMessage = Date.now();
    await saveJSON('private/messages/chats.json', chats);
  }
}

async function deleteMessagesForUsers(user1Id, user2Id) {
  const chatId = generateChatId(user1Id, user2Id);
  const chatDir = path.join(__dirname, 'private', 'messages', 'chats', chatId);
  
  try {
    const messages = await getMessagesForUsers(user1Id, user2Id);
    
    for (const message of messages) {
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
    
    await fs.rmdir(chatDir, { recursive: true });
    console.log(`Deleted chat directory: ${chatDir}`);
    
    const chats = await loadJSON('private/messages/chats.json');
    const filteredChats = chats.filter(chat => chat.id !== chatId);
    await saveJSON('private/messages/chats.json', filteredChats);
    
  } catch (error) {
    console.error(`Error deleting chat ${chatId}:`, error);
  }
}

async function deleteMessageById(messageId) {
  const chats = await loadJSON('private/messages/chats.json');
  
  for (const chat of chats) {
    const chatFile = path.join(__dirname, 'private', 'messages', 'chats', chat.id, `${chat.id}.json`);
    
    try {
      const messages = JSON.parse(await fs.readFile(chatFile, 'utf8'));
      const messageIndex = messages.findIndex(msg => msg.id === messageId);
      
      if (messageIndex !== -1) {
        const message = messages[messageIndex];
        
        if (message.type === 'image' || message.type === 'video') {
          try {
            const filePath = message.type === 'image' 
              ? path.join(__dirname, 'private', 'messages', 'pictures', message.content)
              : path.join(__dirname, 'private', 'messages', 'videos', message.content);
            await fs.unlink(filePath);
            console.log(`Deleted file: ${filePath}`);
          } catch (error) {
            console.error(`Error deleting file ${message.content}:`, error);
          }
        }
        
        messages.splice(messageIndex, 1);
        await fs.writeFile(chatFile, JSON.stringify(messages, null, 2));
        
        return { success: true, message };
      }
    } catch (error) {
      continue;
    }
  }
  
  return { success: false, error: 'Message not found' };
}

async function getFriendshipDetails(user1Id, user2Id) {
  const friends = await loadJSON('private/friends/friends.json');
  return friends.find(f => 
    ((f.user1 === user1Id && f.user2 === user2Id) ||
     (f.user1 === user2Id && f.user2 === user1Id)) &&
    f.status === 'accepted'
  );
}

// Session management (same as before)
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

// Mute management (same as before)
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

// Ban management (same as before)
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

// Server-relayed voice calling functions (REPLACED WebRTC)
function endCall(callId, reason) {
  const call = activeCalls.get(callId);
  if (!call) return;
  
  const callerSocket = getSocketByUserId(call.caller);
  const receiverSocket = getSocketByUserId(call.receiver);
  
  const duration = call.answeredTime ? Date.now() - call.answeredTime : 0;
  
  callTimeTracking.delete(callId);
  audioStreams.delete(callId); // Clean up audio streams
  
  if (callerSocket) {
    callerSocket.emit('call_ended', { callId, reason, duration });
  }
  
  if (receiverSocket) {
    receiverSocket.emit('call_ended', { callId, reason, duration });
  }
  
  activeCalls.delete(callId);
  userCalls.delete(call.caller);
  userCalls.delete(call.receiver);
  
  console.log(`Server-relayed call ${callId} ended: ${reason}, duration: ${duration}ms`);
}

async function sendUpdatedUserLists(socket, userId) {
  try {
    const friends = await loadJSON('private/friends/friends.json');
    const chats = await loadJSON('private/messages/chats.json');
    
    const userFriends = friends.filter(f => 
      (f.user1 === userId || f.user2 === userId) && f.status === 'accepted'
    );
    
    const userFriendsWithDetails = await Promise.all(
      userFriends.map(async (friendship) => {
        const friendId = friendship.user1 === userId ? friendship.user2 : friendship.user1;
        const friendUser = await getUserById(friendId);
        
        const chatId = generateChatId(userId, friendId);
        const chat = chats.find(c => c.id === chatId);
        const lastMessage = chat ? chat.lastMessage : 0;
        
        return {
          ...friendship,
          friendId,
          friendUsername: friendUser ? friendUser.username : 'Unknown User',
          friendRole: friendUser ? friendUser.role : 'user',
          friendTier: friendUser ? getUserTier(friendUser) : 1,
          friendsSince: friendship.acceptedAt || friendship.timestamp,
          lastMessage
        };
      })
    );
    
    userFriendsWithDetails.sort((a, b) => b.lastMessage - a.lastMessage);
    
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

function getSocketByUserId(userId) {
  const userConnection = Array.from(activeUsers.values()).find(u => u.user.id === userId);
  return userConnection ? io.sockets.sockets.get(userConnection.socket) : null;
}

// Rate limiting functions (same as before)
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
  
  if (now - userLimits.lastMessage < 2000) {
    return { allowed: false, reason: 'Please wait 2 seconds between messages' };
  }
  
  userLimits.messages = userLimits.messages.filter(time => now - time < 30000);
  
  if (userLimits.warningsResetTime > 0 && now - userLimits.warningsResetTime > WARNING_RESET_TIME) {
    userLimits.warnings = [];
    userLimits.warningsResetTime = 0;
    userLimits.escalationLevel = 0;
  }
  
  if (userLimits.messages.length >= 5) {
    userLimits.warnings.push(now);
    
    if (userLimits.warnings.length === 1) {
      userLimits.warningsResetTime = now;
    }
    
    if (userLimits.warnings.length >= 3) {
      const muteLevel = userLimits.escalationLevel;
      let muteDuration, reason;
      
      if (muteLevel === 0) {
        muteDuration = FIRST_MUTE_DURATION;
        reason = 'First spam mute (1 minute)';
      } else if (muteLevel === 1) {
        muteDuration = FIRST_MUTE_DURATION;
        reason = 'Second spam mute (1 minute)';
      } else {
        muteDuration = ESCALATED_MUTE_DURATION;
        reason = 'Repeated spam violation (1 hour)';
      }
      
      const muteEnd = now + muteDuration;
      saveMute(userId, muteEnd, reason, muteLevel);
      
      userLimits.escalationLevel++;
      
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
  if (userRole === 'owner') {
    return { allowed: true };
  }
  
  const now = Date.now();
  if (!uploadLimits.has(userId)) {
    uploadLimits.set(userId, { uploads: [], dailyUploads: [] });
  }
  
  const userLimits = uploadLimits.get(userId);
  
  userLimits.uploads = userLimits.uploads.filter(time => now - time < 60000);
  userLimits.dailyUploads = userLimits.dailyUploads.filter(time => now - time < 86400000);
  
  if (userLimits.dailyUploads.length >= 5) {
    return { allowed: false, reason: 'Daily upload limit reached (5 files per day)' };
  }
  
  const recent30min = userLimits.uploads.filter(time => now - time < 1800000);
  if (recent30min.length >= 3) {
    return { allowed: false, reason: 'Upload limit reached (3 files per 30 minutes)' };
  }
  
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

// Real-time call time update function
async function sendCallTimeUpdate(callId) {
  const call = activeCalls.get(callId);
  if (!call || call.status !== 'active') return;
  
  try {
    const callerSocket = getSocketByUserId(call.caller);
    const receiverSocket = getSocketByUserId(call.receiver);
    
    const callerRemainingTime = await getUserRemainingCallTime(call.caller);
    const receiverRemainingTime = await getUserRemainingCallTime(call.receiver);
    
    if (callerSocket) {
      callerSocket.emit('call_time_update', { 
        callId, 
        remainingTime: callerRemainingTime,
        partnerRemainingTime: receiverRemainingTime
      });
    }
    
    if (receiverSocket) {
      receiverSocket.emit('call_time_update', { 
        callId, 
        remainingTime: receiverRemainingTime,
        partnerRemainingTime: callerRemainingTime 
      });
    }
    
    if ((callerRemainingTime === 0 && callerRemainingTime !== -1) || 
        (receiverRemainingTime === 0 && receiverRemainingTime !== -1)) {
      endCall(callId, 'time_limit_reached');
    }
    
  } catch (error) {
    console.error('Error sending call time update:', error);
  }
}

// Socket.IO connection handling with server-relayed audio
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('authenticate', async (data) => {
    try {
      const { username, password, sessionToken } = data;
      let user = null;
      
      if (sessionToken) {
        const userId = await getSessionUserId(sessionToken);
        if (userId) {
          user = await getUserById(userId);
        }
      }
      
      if (!user && username && password) {
        const users = await loadJSON('private/users/users.json');
        user = users.find(u => u.username === username && u.password === password);
        
        if (user) {
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
      
      if (activeUsers.size >= MAX_ACTIVE_USERS && !activeUsers.has(user.id)) {
        socket.emit('auth_error', `Server is currently full (${MAX_ACTIVE_USERS}/${MAX_ACTIVE_USERS} users). Please try again later.`);
        return;
      }
      
      activeUsers.set(user.id, { socket: socket.id, lastActive: Date.now(), user });
      socket.userId = user.id;
      
      const remainingCallTime = await getUserRemainingCallTime(user.id);
      const currentPeriod = getCurrentDynamicWeek();
      
      socket.emit('authenticated', { 
        user: { ...user, password: undefined },
        callTimeRemaining: remainingCallTime,
        currentWeekInfo: currentPeriod
      });
      
      // Load and send friends list with full user details
      const friends = await loadJSON('private/friends/friends.json');
      const chats = await loadJSON('private/messages/chats.json');
      const userFriends = friends.filter(f => 
        (f.user1 === user.id || f.user2 === user.id) && f.status === 'accepted'
      );
      
      const friendsWithDetails = await Promise.all(
        userFriends.map(async (friendship) => {
          const friendId = friendship.user1 === user.id ? friendship.user2 : friendship.user1;
          const friendUser = await getUserById(friendId);
          
          const chatId = generateChatId(user.id, friendId);
          const chat = chats.find(c => c.id === chatId);
          const lastMessage = chat ? chat.lastMessage : 0;
          
          return {
            ...friendship,
            friendId,
            friendUsername: friendUser ? friendUser.username : 'Unknown User',
            friendRole: friendUser ? friendUser.role : 'user',
            friendTier: friendUser ? getUserTier(friendUser) : 1,
            friendsSince: friendship.acceptedAt || friendship.timestamp,
            lastMessage
          };
        })
      );
      
      friendsWithDetails.sort((a, b) => b.lastMessage - a.lastMessage);
      
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
      
    } catch (error) {
      console.error('Authentication error:', error);
      socket.emit('auth_error', 'Server error');
    }
  });
  
  // Server-relayed voice calling handlers (REPLACED WebRTC handlers)
  socket.on('initiate_call', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { friendId } = data;
      const callerId = socket.userId;
      
      if (await isUserMuted(callerId)) {
        socket.emit('call_error', 'You are currently muted');
        return;
      }
      
      if (!(await canUserStartCall(callerId))) {
        socket.emit('call_error', 'You have no remaining call time this week');
        return;
      }
      
      if (!(await canUserStartCall(friendId))) {
        socket.emit('call_error', 'Your friend has no remaining call time this week');
        return;
      }
      
      const friends = await loadJSON('private/friends/friends.json');
      const friendship = friends.find(f => 
        ((f.user1 === callerId && f.user2 === friendId) ||
         (f.user1 === friendId && f.user2 === callerId)) &&
        f.status === 'accepted'
      );
      
      if (!friendship) {
        socket.emit('call_error', 'Can only call friends');
        return;
      }
      
      if (userCalls.has(callerId) || userCalls.has(friendId)) {
        socket.emit('call_error', 'User is already in a call');
        return;
      }
      
      const friendUser = await getUserById(friendId);
      if (friendUser?.settings?.allowCalls === false) {
        socket.emit('call_error', 'This user is not accepting calls');
        return;
      }
      
      const callId = generateUserId();
      const call = {
        id: callId,
        caller: callerId,
        receiver: friendId,
        status: 'ringing',
        startTime: Date.now()
      };
      
      activeCalls.set(callId, call);
      userCalls.set(callerId, callId); // Only caller marked as "in call" initially
      
      // Initialize audio streams for this call
      audioStreams.set(callId, {
        callerStream: [],
        receiverStream: []
      });
      
      const receiverSocket = getSocketByUserId(friendId);
      if (receiverSocket) {
        const callerUser = await getUserById(callerId);
        receiverSocket.emit('incoming_call', {
          callId,
          callerUsername: callerUser.username,
          callerId,
          serverRelayed: true // Flag to indicate server-relayed audio
        });
      } else {
        userCalls.delete(callerId);
        activeCalls.delete(callId);
        audioStreams.delete(callId);
        socket.emit('call_error', 'User is not online');
        return;
      }
      
      socket.emit('call_initiated', { callId, status: 'ringing', serverRelayed: true });
      
      setTimeout(() => {
        const currentCall = activeCalls.get(callId);
        if (currentCall && currentCall.status === 'ringing') {
          userCalls.delete(callerId);
          endCall(callId, 'timeout');
        }
      }, 30000);
      
    } catch (error) {
      console.error('Initiate call error:', error);
      socket.emit('call_error', 'Failed to initiate call');
    }
  });
  
  socket.on('answer_call', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId, accept } = data;
      const call = activeCalls.get(callId);
      
      if (!call || call.receiver !== socket.userId) {
        socket.emit('call_error', 'Invalid call');
        return;
      }
      
      if (accept) {
        if (!(await canUserStartCall(call.caller)) || !(await canUserStartCall(call.receiver))) {
          userCalls.delete(call.caller);
          endCall(callId, 'insufficient_time');
          return;
        }
        
        userCalls.set(call.receiver, callId); // Now mark receiver as "in call"
        
        call.status = 'active';
        call.answeredTime = Date.now();
        
        callTimeTracking.set(callId, {
          startTime: Date.now(),
          lastUpdate: Date.now()
        });
        
        const callerSocket = getSocketByUserId(call.caller);
        const receiverSocket = getSocketByUserId(call.receiver);
        
        if (callerSocket) {
          callerSocket.emit('call_answered', { callId, serverRelayed: true });
        }
        
        socket.emit('call_connected', { callId, serverRelayed: true });
        
        // Start real-time time updates
        const timeUpdateInterval = setInterval(async () => {
          const currentCall = activeCalls.get(callId);
          if (!currentCall || currentCall.status !== 'active') {
            clearInterval(timeUpdateInterval);
            return;
          }
          
          const tracking = callTimeTracking.get(callId);
          if (tracking) {
            const now = Date.now();
            const timeSinceLastUpdate = now - tracking.lastUpdate;
            
            await updateUserCallTime(call.caller, timeSinceLastUpdate);
            await updateUserCallTime(call.receiver, timeSinceLastUpdate);
            
            tracking.lastUpdate = now;
            
            await sendCallTimeUpdate(callId);
          }
        }, 1000);
        
      } else {
        userCalls.delete(call.caller);
        endCall(callId, 'declined');
      }
      
    } catch (error) {
      console.error('Answer call error:', error);
      socket.emit('call_error', 'Failed to answer call');
    }
  });
  
  socket.on('end_call', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId } = data;
      const call = activeCalls.get(callId);
      
      if (!call) {
        socket.emit('call_error', 'Call not found');
        return;
      }
      
      if (call.caller !== socket.userId && call.receiver !== socket.userId) {
        socket.emit('call_error', 'You are not in this call');
        return;
      }
      
      const tracking = callTimeTracking.get(callId);
      if (tracking && call.status === 'active') {
        const now = Date.now();
        const finalTime = now - tracking.lastUpdate;
        await updateUserCallTime(call.caller, finalTime);
        await updateUserCallTime(call.receiver, finalTime);
      }
      
      endCall(callId, 'ended');
      
    } catch (error) {
      console.error('End call error:', error);
      socket.emit('call_error', 'Failed to end call');
    }
  });
  
  socket.on('get_call_time', async () => {
    try {
      if (!socket.userId) return;
      
      const remainingTime = await getUserRemainingCallTime(socket.userId);
      const currentPeriod = getCurrentDynamicWeek();
      
      socket.emit('call_time_remaining', { 
        remainingTime,
        weekInfo: currentPeriod
      });
      
    } catch (error) {
      console.error('Get call time error:', error);
    }
  });
  
  // Server-relayed audio streaming handlers (REPLACED WebRTC signaling)
  socket.on('audio_stream', (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId, audioData } = data;
      const call = activeCalls.get(callId);
      
      if (!call || call.status !== 'active') return;
      if (call.caller !== socket.userId && call.receiver !== socket.userId) return;
      
      // Relay audio to the other participant
      const otherUserId = call.caller === socket.userId ? call.receiver : call.caller;
      const otherSocket = getSocketByUserId(otherUserId);
      
      if (otherSocket) {
        // Simple bandwidth limiting: limit audio chunks to 32kbps equivalent
        const maxChunkSize = Math.floor(AUDIO_BITRATE / 8 / (1000 / AUDIO_CHUNK_INTERVAL));
        
        if (audioData && audioData.length <= maxChunkSize) {
          otherSocket.emit('audio_stream', { callId, audioData });
        }
      }
      
    } catch (error) {
      console.error('Audio stream error:', error);
    }
  });
  
  socket.on('audio_settings', (data) => {
    try {
      if (!socket.userId) return;
      
      const { callId, muted, volume } = data;
      const call = activeCalls.get(callId);
      
      if (!call || call.status !== 'active') return;
      if (call.caller !== socket.userId && call.receiver !== socket.userId) return;
      
      // Relay audio settings to the other participant
      const otherUserId = call.caller === socket.userId ? call.receiver : call.caller;
      const otherSocket = getSocketByUserId(otherUserId);
      
      if (otherSocket) {
        otherSocket.emit('audio_settings', { callId, partnerMuted: muted, partnerVolume: volume });
      }
      
    } catch (error) {
      console.error('Audio settings error:', error);
    }
  });
  
  // All other socket handlers remain the same (messaging, friend management, etc.)
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
      
      const chats = await loadJSON('private/messages/chats.json');
      let foundMessage = null;
      let messageSender = null;
      
      for (const chat of chats) {
        const messages = await getMessagesForUsers(chat.participants[0], chat.participants[1]);
        const message = messages.find(m => m.id === messageId);
        if (message) {
          foundMessage = message;
          messageSender = await getUserById(message.senderId);
          break;
        }
      }
      
      if (!foundMessage) {
        socket.emit('message_error', 'Message not found');
        return;
      }
      
      let canDelete = false;
      
      if (foundMessage.senderId === socket.userId) {
        canDelete = true;
      } else if (currentUser.role === 'owner') {
        canDelete = true;
      } else if (currentUser.role === 'admin' && messageSender && messageSender.role !== 'owner') {
        canDelete = true;
      }
      
      if (!canDelete) {
        socket.emit('message_error', 'You do not have permission to delete this message');
        return;
      }
      
      const result = await deleteMessageById(messageId);
      
      if (result.success) {
        const senderId = foundMessage.senderId;
        const receiverId = foundMessage.receiverId;
        
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
      
      if (await isUserMuted(socket.userId)) {
        socket.emit('message_error', 'You are currently muted');
        return;
      }
      
      if (!content || content.trim().length === 0) {
        socket.emit('message_error', 'Message cannot be empty');
        return;
      }
      
      if (content.length > MAX_MESSAGE_LENGTH) {
        socket.emit('message_error', `Message too long (${content.length}/${MAX_MESSAGE_LENGTH} characters)`);
        return;
      }
      
      const limitCheck = checkMessageLimit(socket.userId);
      if (!limitCheck.allowed) {
        socket.emit('message_error', limitCheck.reason);
        return;
      }
      
      const friends = await loadJSON('private/friends/friends.json');
      const friendship = friends.find(f => 
        ((f.user1 === socket.userId && f.user2 === receiverId) ||
         (f.user1 === receiverId && f.user2 === socket.userId))
      );
      
      if (!friendship || friendship.status !== 'accepted') {
        socket.emit('message_error', 'Can only message friends');
        return;
      }
      
      const message = {
        id: generateUserId(),
        senderId: socket.userId,
        receiverId,
        content,
        type: 'text',
        timestamp: Date.now()
      };
      
      await saveMessageToChat(socket.userId, receiverId, message);
      
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
      
      if (targetUser.settings && targetUser.settings.allowFriendRequests === false) {
        socket.emit('friend_request_error', 'This user is not accepting friend requests');
        return;
      }
      
      const friends = await loadJSON('private/friends/friends.json');
      
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
      
      friendRequestCooldowns.set(socket.userId, Date.now());
      
      const friendRequest = {
        id: generateUserId(),
        user1: socket.userId,
        user2: targetUser.id,
        status: 'pending',
        timestamp: Date.now()
      };
      
      friends.push(friendRequest);
      await saveJSON('private/friends/friends.json', friends);
      
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
        friends.splice(requestIndex, 1);
      }
      
      await saveJSON('private/friends/friends.json', friends);
      
      const senderSocket = getSocketByUserId(request.user1);
      if (senderSocket) {
        if (accept) {
          const accepter = await getUserById(socket.userId);
          senderSocket.emit('friend_request_accepted', {
            username: accepter.username,
            userId: socket.userId
          });
          
          await sendUpdatedUserLists(senderSocket, request.user1);
        }
      }
      
      if (accept) {
        await sendUpdatedUserLists(socket, socket.userId);
      }
      
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
      
      await deleteMessagesForUsers(socket.userId, targetUserId);
      
      const relationshipIndex = friends.findIndex(f => 
        (f.user1 === socket.userId && f.user2 === targetUserId) ||
        (f.user1 === targetUserId && f.user2 === socket.userId)
      );
      
      if (relationshipIndex !== -1) {
        friends[relationshipIndex].status = 'blocked';
        friends[relationshipIndex].blockedBy = socket.userId;
        friends[relationshipIndex].blockedAt = Date.now();
      } else {
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
      
      const filteredFriends = friends.filter(f => 
        !((f.user1 === socket.userId && f.user2 === targetUserId) ||
          (f.user1 === targetUserId && f.user2 === socket.userId)) ||
        f.status !== 'blocked' ||
        f.blockedBy !== socket.userId
      );
      
      await saveJSON('private/friends/friends.json', filteredFriends);
      
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
      
      if (!canAdminAction(currentUser, targetUser)) {
        socket.emit('message_error', 'You do not have permission to mute this user');
        return;
      }
      
      let muteDuration;
      switch (duration) {
        case '1h':
          muteDuration = 60 * 60 * 1000;
          break;
        case '1d':
          muteDuration = 24 * 60 * 60 * 1000;
          break;
        case '1w':
          muteDuration = 7 * 24 * 60 * 60 * 1000;
          break;
        default:
          muteDuration = 60 * 60 * 1000;
      }
      
      const muteEnd = Date.now() + muteDuration;
      await saveAdminMute(userId, muteEnd, reason || 'Muted by admin');
      
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
      
      const { allowFriendRequests, allowNotifications, allowCalls } = data;
      
      const users = await loadJSON('private/users/users.json');
      const userIndex = users.findIndex(u => u.id === socket.userId);
      
      if (userIndex === -1) {
        socket.emit('settings_error', 'User not found');
        return;
      }
      
      if (!users[userIndex].settings) {
        users[userIndex].settings = {};
      }
      
      if (allowFriendRequests !== undefined) {
        users[userIndex].settings.allowFriendRequests = allowFriendRequests;
      }
      
      if (allowNotifications !== undefined) {
        users[userIndex].settings.allowNotifications = allowNotifications;
      }
      
      if (allowCalls !== undefined) {
        users[userIndex].settings.allowCalls = allowCalls;
      }
      
      await saveJSON('private/users/users.json', users);
      
      socket.emit('settings_updated', { 
        allowFriendRequests: users[userIndex].settings.allowFriendRequests,
        allowNotifications: users[userIndex].settings.allowNotifications,
        allowCalls: users[userIndex].settings.allowCalls
      });
      
    } catch (error) {
      console.error('Settings update error:', error);
      socket.emit('settings_error', 'Failed to update settings');
    }
  });
  
  socket.on('logout', async () => {
    if (socket.userId) {
      const callId = userCalls.get(socket.userId);
      if (callId) {
        const call = activeCalls.get(callId);
        if (call) {
          const tracking = callTimeTracking.get(callId);
          if (tracking && call.status === 'active') {
            const now = Date.now();
            const finalTime = now - tracking.lastUpdate;
            await updateUserCallTime(call.caller, finalTime);
            await updateUserCallTime(call.receiver, finalTime);
          }
          endCall(callId, 'disconnected');
        }
      }
      
      await deleteUserSessions(socket.userId);
      
      activeUsers.delete(socket.userId);
      socket.userId = null;
    }
    
    socket.emit('logged_out');
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.userId) {
      const callId = userCalls.get(socket.userId);
      if (callId) {
        endCall(callId, 'disconnected');
      }
      
      activeUsers.delete(socket.userId);
    }
  });
});

// API Routes (same as before but with updated call time limits)
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
      password,
      tier: 1,
      role: 'user',
      banned: false,
      created: Date.now(),
      settings: {
        allowFriendRequests: true,
        allowNotifications: true,
        allowCalls: true
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
    
    const users = await loadJSON('private/users/users.json');
    const user = users.find(u => u.id === userId);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid user' });
    }
    
    const userTier = getUserTier(user);
    const isVideo = req.file.mimetype.startsWith('video/');
    
    if (user.role !== 'owner') {
      if (userTier < 2) {
        return res.status(403).json({ error: 'Insufficient tier for file uploads (Need Tier 2+)' });
      }
      
      if (isVideo && userTier < 3) {
        return res.status(403).json({ error: 'Insufficient tier for video uploads (Need Tier 3)' });
      }
    }
    
    if (await isUserMuted(userId)) {
      return res.status(403).json({ error: 'You are currently muted' });
    }
    
    const limitCheck = checkUploadLimit(userId, isVideo, user.role);
    if (!limitCheck.allowed) {
      return res.status(429).json({ error: limitCheck.reason });
    }
    
    const friends = await loadJSON('private/friends/friends.json');
    const friendship = friends.find(f => 
      ((f.user1 === userId && f.user2 === receiverId) ||
       (f.user1 === receiverId && f.user2 === userId)) &&
      f.status === 'accepted'
    );
    
    if (!friendship) {
      return res.status(403).json({ error: 'Can only send files to friends' });
    }
    
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const filename = uniqueSuffix + path.extname(req.file.originalname);
    const dir = isVideo ? 'private/messages/videos/' : 'private/messages/pictures/';
    savedFilePath = path.join(__dirname, dir, filename);
    
    await fs.writeFile(savedFilePath, req.file.buffer);
    
    const message = {
      id: generateUserId(),
      senderId: userId,
      receiverId,
      content: filename,
      type: isVideo ? 'video' : 'image',
      timestamp: Date.now()
    };
    
    await saveMessageToChat(userId, receiverId, message);
    
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

app.get('/api/media/:filename', async (req, res) => {
  const filename = req.params.filename;
  const imagePath = path.join(__dirname, 'private', 'messages', 'pictures', filename);
  const videoPath = path.join(__dirname, 'private', 'messages', 'videos', filename);
  
  try {
    await fs.access(imagePath);
    res.sendFile(imagePath);
  } catch {
    try {
      await fs.access(videoPath);
      res.sendFile(videoPath);
    } catch {
      res.status(404).send('File not found');
    }
  }
});

// Admin API Routes (same as before)
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
    
    const usersWithMuteStatus = users.map(user => {
      const activeMute = mutes.find(m => m.userId === user.id && m.muteEnd > Date.now());
      return {
        ...user,
        password: undefined,
        muted: !!activeMute,
        muteEnd: activeMute ? activeMute.muteEnd : null,
        muteReason: activeMute ? activeMute.reason : null
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
    
    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
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
    
    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    let muteDuration;
    switch (duration) {
      case '1h':
        muteDuration = 60 * 60 * 1000;
        break;
      case '1d':
        muteDuration = 24 * 60 * 60 * 1000;
        break;
      case '1w':
        muteDuration = 7 * 24 * 60 * 60 * 1000;
        break;
      default:
        muteDuration = 60 * 60 * 1000;
    }
    
    const muteEnd = Date.now() + muteDuration;
    await saveAdminMute(userId, muteEnd, reason || 'Muted by admin');
    
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
      zlib: { level: 9 }
    });
    
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      res.status(500).json({ error: 'Failed to create backup' });
    });
    
    archive.pipe(res);
    
    archive.directory('private/', false);
    
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
    const currentPeriod = getCurrentDynamicWeek();
    
    res.json({
      activeUsers: activeUsers.size,
      maxUsers: MAX_ACTIVE_USERS,
      mutedUsers: activeMutes.length,
      activeCalls: activeCalls.size,
      currentWeek: currentPeriod,
      serverRelayedAudio: true
    });
  } catch (error) {
    res.json({
      activeUsers: activeUsers.size,
      maxUsers: MAX_ACTIVE_USERS,
      mutedUsers: 0,
      activeCalls: activeCalls.size,
      serverRelayedAudio: true
    });
  }
});

app.post('/api/admin/cleanup', async (req, res) => {
  try {
    console.log('Manual cleanup initiated...');
    await cleanupOldMessages();
    await cleanupOrphanedMediaFiles();
    await cleanupOldSessions();
    await cleanupExpiredMutes();
    
    res.json({ message: 'Cleanup completed successfully' });
  } catch (error) {
    console.error('Manual cleanup error:', error);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// Settings API endpoints (same as before)
app.get('/api/settings', async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace('Bearer ', '');
    if (!sessionToken) {
      return res.status(401).json({ error: 'No session token provided' });
    }
    
    const userId = await getSessionUserId(sessionToken);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid session token' });
    }
    
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const remainingCallTime = await getUserRemainingCallTime(userId);
    const currentPeriod = getCurrentDynamicWeek();
    
    res.json({
      allowFriendRequests: user.settings?.allowFriendRequests ?? true,
      allowNotifications: user.settings?.allowNotifications ?? true,
      allowCalls: user.settings?.allowCalls ?? true,
      callTimeRemaining: remainingCallTime,
      currentWeek: currentPeriod
    });
    
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/settings/notifications', async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace('Bearer ', '');
    if (!sessionToken) {
      return res.status(401).json({ error: 'No session token provided' });
    }
    
    const userId = await getSessionUserId(sessionToken);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid session token' });
    }
    
    const { allowNotifications } = req.body;
    if (typeof allowNotifications !== 'boolean') {
      return res.status(400).json({ error: 'allowNotifications must be a boolean' });
    }
    
    const users = await loadJSON('private/users/users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!users[userIndex].settings) {
      users[userIndex].settings = {};
    }
    
    users[userIndex].settings.allowNotifications = allowNotifications;
    await saveJSON('private/users/users.json', users);
    
    res.json({ 
      message: 'Notifications setting updated successfully',
      allowNotifications 
    });
    
  } catch (error) {
    console.error('Update notifications setting error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/settings/friend-requests', async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace('Bearer ', '');
    if (!sessionToken) {
      return res.status(401).json({ error: 'No session token provided' });
    }
    
    const userId = await getSessionUserId(sessionToken);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid session token' });
    }
    
    const { allowFriendRequests } = req.body;
    if (typeof allowFriendRequests !== 'boolean') {
      return res.status(400).json({ error: 'allowFriendRequests must be a boolean' });
    }
    
    const users = await loadJSON('private/users/users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!users[userIndex].settings) {
      users[userIndex].settings = {};
    }
    
    users[userIndex].settings.allowFriendRequests = allowFriendRequests;
    await saveJSON('private/users/users.json', users);
    
    res.json({ 
      message: 'Friend requests setting updated successfully',
      allowFriendRequests 
    });
    
  } catch (error) {
    console.error('Update friend requests setting error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/settings/calls', async (req, res) => {
  try {
    const sessionToken = req.headers.authorization?.replace('Bearer ', '');
    if (!sessionToken) {
      return res.status(401).json({ error: 'No session token provided' });
    }
    
    const userId = await getSessionUserId(sessionToken);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid session token' });
    }
    
    const { allowCalls } = req.body;
    if (typeof allowCalls !== 'boolean') {
      return res.status(400).json({ error: 'allowCalls must be a boolean' });
    }
    
    const users = await loadJSON('private/users/users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!users[userIndex].settings) {
      users[userIndex].settings = {};
    }
    
    users[userIndex].settings.allowCalls = allowCalls;
    await saveJSON('private/users/users.json', users);
    
    res.json({ 
      message: 'Calls setting updated successfully',
      allowCalls 
    });
    
  } catch (error) {
    console.error('Update calls setting error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Enhanced cleanup routines - runs every 30 minutes
setInterval(async () => {
  console.log('Running scheduled cleanup...');
  await cleanupOldSessions();
  await cleanupExpiredMutes();
  await cleanupOldMessages();
  await cleanupOrphanedMediaFiles();
}, 30 * 60 * 1000); // Run every 30 minutes

// Periodic cleanup of stale calls - runs every minute
setInterval(() => {
  const now = Date.now();
  const staleCallTimeout = 5 * 60 * 1000; // 5 minutes
  
  for (const [callId, call] of activeCalls.entries()) {
    if (now - call.startTime > staleCallTimeout) {
      console.log(`Cleaning up stale call: ${callId}`);
      endCall(callId, 'timeout');
    }
  }
}, 60000); // Check every minute

// Initialize and start server
async function start() {
  await initializeDirectories();
  
  server.listen(PORT, () => {
    console.log(`PulseChat server running on port ${PORT}`);
    console.log(`Admin API key: ${ADMIN_API_KEY}`);
    console.log(`Max active users: ${MAX_ACTIVE_USERS}`);
    console.log(`Message retention: 48 hours`);
    console.log(`Max messages per chat: ${MAX_MESSAGES_PER_CHAT}`);
    console.log(`Server-relayed voice calls enabled (32kbps)`);
    console.log(`Updated call time limits: Tier 1: 5h/week, Tier 2: 10h/week, Tier 3: 15h/week`);
    console.log(`Dynamic week calculation based on days in current month`);
    console.log(`Bulletproof time tracking with automatic resets`);
  });
}

start();