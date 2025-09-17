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
const MESSAGE_RETENTION_TIME = 48 * 60 * 60 * 1000; // 48 hours in milliseconds
const MAX_MESSAGES_PER_CHAT = 250; // Maximum messages to keep per chat
const FILE_UPLOAD_COOLDOWN = 60 * 1000; // 1 minute for pictures, videos, documents
const VOICE_MESSAGE_COOLDOWN = 2 * 1000; // 2 seconds for voice messages
const MAX_DOCUMENT_SIZE = 50 * 1024; // 50KB
const MAX_VOICE_SIZE = 2 * 1024 * 1024; // 2MB

// Updated tier limits - NO MORE TIER 1 FREE
const TIER_LIMITS = {
  1: { // 100€/lifetime
    pictures: 5,
    videos: 5,
    documents: 10,
    voice: 20
  },
  2: { // 150€/lifetime
    pictures: 15,
    videos: 10,
    documents: 25,
    voice: 50
  },
  3: { // 150€/lifetime
    pictures: 40,
    videos: 25,
    documents: 50,
    voice: 100
  }
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

// In-memory storage for active users and message rate limiting
const activeUsers = new Map();
const messageLimits = new Map();
const friendRequestCooldowns = new Map();

// Message cache to prevent ghost messages
const messageCache = new Map(); // chatId -> messages array

// Upload tracking - now persistent
let uploadTracking = {
  lastReset: getCurrentDateString(),
  users: {}
};

// Helper function to get current date as string (YYYY-MM-DD)
function getCurrentDateString() {
  return new Date().toISOString().split('T')[0];
}

// Load upload tracking from file
async function loadUploadTracking() {
  try {
    const data = await fs.readFile('private/cooldowns/upload_tracking.json', 'utf8');
    uploadTracking = JSON.parse(data);
    
    // Check if we need to reset daily limits
    await checkAndResetDailyLimits();
  } catch (error) {
    // File doesn't exist, use default structure
    uploadTracking = {
      lastReset: getCurrentDateString(),
      users: {}
    };
    await saveUploadTracking();
  }
}

// Save upload tracking to file
async function saveUploadTracking() {
  try {
    await fs.writeFile('private/cooldowns/upload_tracking.json', JSON.stringify(uploadTracking, null, 2));
  } catch (error) {
    console.error('Error saving upload tracking:', error);
  }
}

// Check if it's a new day and reset daily limits
async function checkAndResetDailyLimits() {
  const currentDate = getCurrentDateString();
  
  if (uploadTracking.lastReset !== currentDate) {
    console.log(`Resetting daily upload limits (last reset: ${uploadTracking.lastReset}, current: ${currentDate})`);
    
    // Reset all user daily upload counts
    for (const userId in uploadTracking.users) {
      const user = uploadTracking.users[userId];
      if (user.pictures) user.pictures.dailyUploads = [];
      if (user.videos) user.videos.dailyUploads = [];
      if (user.documents) user.documents.dailyUploads = [];
      if (user.voice) user.voice.dailyUploads = [];
    }
    
    uploadTracking.lastReset = currentDate;
    await saveUploadTracking();
  }
}

// Get or create user upload tracking
function getUserUploadData(userId) {
  if (!uploadTracking.users[userId]) {
    uploadTracking.users[userId] = {
      pictures: { dailyUploads: [], lastUpload: 0 },
      videos: { dailyUploads: [], lastUpload: 0 },
      documents: { dailyUploads: [], lastUpload: 0 },
      voice: { dailyUploads: [], lastUpload: 0 }
    };
  }
  return uploadTracking.users[userId];
}

// Ensure directories exist
async function initializeDirectories() {
  const dirs = [
    'private',
    'private/chats',
    'private/users',
    'private/friends',
    'private/logins',
    'private/mutes',
    'private/cooldowns',
    'private/requests' // New directory for pending requests
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
    'private/chats.json',
    'private/users/users.json',
    'private/friends/friends.json',
    'private/logins/logins.json',
    'private/mutes/mutes.json',
    'private/requests/requests.json' // New file for pending requests
  ];
  
  for (const file of files) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, JSON.stringify([], null, 2));
    }
  }
  
  // Load upload tracking
  await loadUploadTracking();
}

// File upload configuration - Using memory storage first for validation
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedImages = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const allowedVideos = ['video/mp4', 'video/webm', 'video/quicktime'];
  const allowedDocuments = ['text/plain'];
  const allowedAudio = ['audio/webm']; // ONLY WebM audio files
  
  if (allowedImages.includes(file.mimetype) || 
      allowedVideos.includes(file.mimetype) || 
      allowedDocuments.includes(file.mimetype) ||
      allowedAudio.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB (we'll check specific limits per file type)
  }
});

// Helper function to validate WebM file
function validateWebM(buffer) {
  // Check WebM signature (starts with 1A 45 DF A3)
  if (buffer.length < 4) return false;
  
  // Check for WebM/EBML header
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return true;
  }
  
  return false;
}

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
    return 3; // Staff gets highest tier
  }
  return user.tier || 0; // Default to 0 (pending)
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

// New function to get pending request by username
async function getPendingRequestByUsername(username) {
  const requests = await loadJSON('private/requests/requests.json');
  return requests.find(r => r.username === username);
}

// Function to check if user is approved (tier > 0)
function isUserApproved(user) {
  if (!user) return false;
  
  // Staff roles are always approved
  if (['owner', 'admin', 'developer'].includes(user.role)) {
    return true;
  }
  
  // Regular users need tier 1+ to be approved
  return user.tier && user.tier > 0;
}

// Generate consistent chat ID for two users
function generateChatId(user1Id, user2Id) {
  // Sort IDs to ensure consistent chat ID regardless of order
  const sortedIds = [user1Id, user2Id].sort();
  return `${sortedIds[0]}_${sortedIds[1]}`;
}

// Chat management functions
async function getChatInfo(chatId) {
  const chats = await loadJSON('private/chats.json');
  return chats.find(chat => chat.id === chatId);
}

async function createChat(user1Id, user2Id) {
  const chatId = generateChatId(user1Id, user2Id);
  const chats = await loadJSON('private/chats.json');
  
  // Check if chat already exists
  const existingChat = chats.find(chat => chat.id === chatId);
  if (existingChat) {
    return existingChat;
  }
  
  // Create new chat record
  const newChat = {
    id: chatId,
    participants: [user1Id, user2Id],
    created: Date.now(),
    lastMessage: Date.now()
  };
  
  chats.push(newChat);
  await saveJSON('private/chats.json', chats);
  
  // Create chat directory structure
  const chatDir = path.join(__dirname, 'private', 'chats', chatId);
  await fs.mkdir(chatDir, { recursive: true });
  
  // Create subdirectories for media types
  const mediaTypes = ['pictures', 'videos', 'documents', 'audios'];
  for (const mediaType of mediaTypes) {
    await fs.mkdir(path.join(chatDir, mediaType), { recursive: true });
  }
  
  // Create chat messages file
  const chatFile = path.join(chatDir, `${chatId}.json`);
  await fs.writeFile(chatFile, JSON.stringify([], null, 2));
  
  // Initialize cache
  messageCache.set(chatId, []);
  
  return newChat;
}

// Helper function to check if a file exists
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Helper function to get the file path for a message within its chat directory
function getMessageFilePath(message, chatId) {
  if (!['image', 'video', 'document', 'audio'].includes(message.type)) {
    return null;
  }
  
  let mediaDir;
  switch (message.type) {
    case 'image':
      mediaDir = 'pictures';
      break;
    case 'video':
      mediaDir = 'videos';
      break;
    case 'document':
      mediaDir = 'documents';
      break;
    case 'audio':
      mediaDir = 'audios';
      break;
    default:
      return null;
  }
  
  return path.join(__dirname, 'private', 'chats', chatId, mediaDir, message.content);
}

// Enhanced function to validate and clean messages before returning them
async function validateAndCleanMessages(messages, chatId) {
  let hasChanges = false;
  const validatedMessages = [];
  
  for (const message of messages) {
    // Check if message has a file attachment
    if (['image', 'video', 'document', 'audio'].includes(message.type)) {
      const filePath = getMessageFilePath(message, chatId);
      
      if (filePath && !(await fileExists(filePath))) {
        // File doesn't exist, mark for removal
        console.log(`Ghost message detected: ${message.id} - file ${message.content} not found in chat ${chatId}, removing from chat`);
        hasChanges = true;
        continue; // Skip this message
      }
    }
    
    // Message is valid, keep it
    validatedMessages.push(message);
  }
  
  // If we found ghost messages, save the cleaned messages back to file
  if (hasChanges) {
    const chatFile = path.join(__dirname, 'private', 'chats', chatId, `${chatId}.json`);
    
    try {
      await fs.writeFile(chatFile, JSON.stringify(validatedMessages, null, 2));
      console.log(`Cleaned ${messages.length - validatedMessages.length} ghost messages from chat ${chatId}`);
      
      // Update cache
      messageCache.set(chatId, validatedMessages.slice());
    } catch (error) {
      console.error(`Error saving cleaned messages for chat ${chatId}:`, error);
    }
  }
  
  return validatedMessages;
}

// Enhanced function to load ALL messages for a chat with caching and ghost message prevention
async function getMessagesForUsers(user1Id, user2Id) {
  const chatId = generateChatId(user1Id, user2Id);
  
  // Check cache first, but still validate for ghost messages periodically
  const cachedMessages = messageCache.get(chatId);
  
  const chatFile = path.join(__dirname, 'private', 'chats', chatId, `${chatId}.json`);
  
  try {
    const data = await fs.readFile(chatFile, 'utf8');
    const messages = JSON.parse(data);
    
    // Sort by timestamp (oldest first for display)
    const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
    
    // Validate and clean messages (removes ghost messages)
    const validatedMessages = await validateAndCleanMessages(sortedMessages, chatId);
    
    // Update cache with validated messages
    messageCache.set(chatId, validatedMessages.slice());
    
    return validatedMessages;
  } catch (error) {
    // Chat doesn't exist yet, return empty array
    const emptyMessages = [];
    messageCache.set(chatId, emptyMessages);
    return emptyMessages;
  }
}

// Enhanced message cleanup function
async function cleanupOldMessages() {
  console.log('Starting message cleanup...');
  const now = Date.now();
  const cutoffTime = now - MESSAGE_RETENTION_TIME;
  let totalDeleted = 0;
  let filesDeleted = 0;
  
  try {
    const chats = await loadJSON('private/chats.json');
    
    for (const chat of chats) {
      const chatFile = path.join(__dirname, 'private', 'chats', chat.id, `${chat.id}.json`);
      
      try {
        const data = await fs.readFile(chatFile, 'utf8');
        const messages = JSON.parse(data);
        const initialCount = messages.length;
        
        // First validate messages for ghost files
        const validatedMessages = await validateAndCleanMessages(messages, chat.id);
        
        // Separate messages to keep and delete based on BOTH time and count
        const messagesToDelete = validatedMessages.filter(msg => msg.timestamp < cutoffTime);
        let messagesToKeep = validatedMessages.filter(msg => msg.timestamp >= cutoffTime);
        
        // Delete associated media files for old messages
        for (const message of messagesToDelete) {
          if (['image', 'video', 'document', 'audio'].includes(message.type)) {
            try {
              const filePath = getMessageFilePath(message, chat.id);
              if (filePath) {
                await fs.unlink(filePath);
                filesDeleted++;
              }
            } catch (error) {
              // File might already be deleted or not exist
              console.log(`Could not delete media file ${message.content}: ${error.message}`);
            }
          }
        }
        
        // Apply message count limit as well (keep most recent messages)
        if (messagesToKeep.length > MAX_MESSAGES_PER_CHAT) {
          // Sort by timestamp and keep the most recent ones
          messagesToKeep.sort((a, b) => b.timestamp - a.timestamp);
          const excessMessages = messagesToKeep.slice(MAX_MESSAGES_PER_CHAT);
          messagesToKeep = messagesToKeep.slice(0, MAX_MESSAGES_PER_CHAT);
          
          // Delete media files for excess messages too
          for (const message of excessMessages) {
            if (['image', 'video', 'document', 'audio'].includes(message.type)) {
              try {
                const filePath = getMessageFilePath(message, chat.id);
                if (filePath) {
                  await fs.unlink(filePath);
                  filesDeleted++;
                }
              } catch (error) {
                console.log(`Could not delete excess media file ${message.content}:`, error.message);
              }
            }
          }
        }
        
        // Save cleaned messages back to file
        if (messagesToKeep.length !== initialCount) {
          await fs.writeFile(chatFile, JSON.stringify(messagesToKeep, null, 2));
          const deletedCount = initialCount - messagesToKeep.length;
          totalDeleted += deletedCount;
          
          // Update cache
          messageCache.set(chat.id, messagesToKeep.slice());
          
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

// Enhanced function to clean up orphaned media files
async function cleanupOrphanedMediaFiles() {
  console.log('Starting orphaned media cleanup...');
  let orphanedFiles = 0;
  
  try {
    const chats = await loadJSON('private/chats.json');
    
    for (const chat of chats) {
      try {
        // Get all referenced files in this chat
        const messages = await getMessagesForUsers(chat.participants[0], chat.participants[1]);
        const referencedFiles = new Set();
        
        for (const message of messages) {
          if (['image', 'video', 'document', 'audio'].includes(message.type)) {
            referencedFiles.add(message.content);
          }
        }
        
        // Check each media directory in this chat
        const chatDir = path.join(__dirname, 'private', 'chats', chat.id);
        const mediaDirs = ['pictures', 'videos', 'documents', 'audios'];
        
        for (const mediaDir of mediaDirs) {
          const mediaDirPath = path.join(chatDir, mediaDir);
          
          try {
            const files = await fs.readdir(mediaDirPath);
            for (const file of files) {
              if (!referencedFiles.has(file)) {
                try {
                  await fs.unlink(path.join(mediaDirPath, file));
                  orphanedFiles++;
                  console.log(`Deleted orphaned ${mediaDir} file from chat ${chat.id}: ${file}`);
                } catch (error) {
                  console.error(`Error deleting orphaned ${mediaDir} file ${file} from chat ${chat.id}:`, error);
                }
              }
            }
          } catch (error) {
            // Directory might not exist, which is fine
            if (error.code !== 'ENOENT') {
              console.error(`Error reading ${mediaDir} directory for chat ${chat.id}:`, error);
            }
          }
        }
        
      } catch (error) {
        console.error(`Error checking chat ${chat.id} for orphaned media:`, error);
      }
    }
    
    console.log(`Orphaned media cleanup completed: ${orphanedFiles} files deleted`);
    
  } catch (error) {
    console.error('Error during orphaned media cleanup:', error);
  }
}

async function saveMessageToChat(user1Id, user2Id, message) {
  const chatId = generateChatId(user1Id, user2Id);
  
  // Ensure chat exists
  await createChat(user1Id, user2Id);
  
  // Load existing messages from cache or file (with validation)
  const messages = await getMessagesForUsers(user1Id, user2Id);
  
  // Add new message
  messages.push(message);
  
  // Sort by timestamp and enforce message limit
  messages.sort((a, b) => a.timestamp - b.timestamp);
  
  // Keep only the most recent messages if we exceed the limit
  let finalMessages = messages;
  if (messages.length > MAX_MESSAGES_PER_CHAT) {
    const excessMessages = messages.slice(0, messages.length - MAX_MESSAGES_PER_CHAT);
    finalMessages = messages.slice(-MAX_MESSAGES_PER_CHAT);
    
    // Delete associated files for excess messages
    for (const oldMessage of excessMessages) {
      if (['image', 'video', 'document', 'audio'].includes(oldMessage.type)) {
        try {
          const filePath = getMessageFilePath(oldMessage, chatId);
          if (filePath) {
            await fs.unlink(filePath);
            console.log(`Deleted excess message file: ${filePath}`);
          }
        } catch (error) {
          console.log(`Could not delete excess file ${oldMessage.content}:`, error.message);
        }
      }
    }
  }
  
  // Save messages back to chat file
  const chatFile = path.join(__dirname, 'private', 'chats', chatId, `${chatId}.json`);
  await fs.writeFile(chatFile, JSON.stringify(finalMessages, null, 2));
  
  // Update cache
  messageCache.set(chatId, finalMessages.slice());
  
  // Update last message time in chats.json
  const chats = await loadJSON('private/chats.json');
  const chatIndex = chats.findIndex(chat => chat.id === chatId);
  if (chatIndex !== -1) {
    chats[chatIndex].lastMessage = Date.now();
    await saveJSON('private/chats.json', chats);
  }
}

async function deleteMessagesForUsers(user1Id, user2Id) {
  const chatId = generateChatId(user1Id, user2Id);
  const chatDir = path.join(__dirname, 'private', 'chats', chatId);
  
  try {
    // Clear cache first
    messageCache.delete(chatId);
    
    // Delete the entire chat directory (includes all files and subdirectories)
    await fs.rmdir(chatDir, { recursive: true });
    console.log(`Deleted chat directory: ${chatDir}`);
    
    // Remove chat from chats.json
    const chats = await loadJSON('private/chats.json');
    const filteredChats = chats.filter(chat => chat.id !== chatId);
    await saveJSON('private/chats.json', filteredChats);
    
  } catch (error) {
    console.error(`Error deleting chat ${chatId}:`, error);
  }
}

async function deleteMessageById(messageId) {
  const chats = await loadJSON('private/chats.json');
  
  // Search through all chats to find the message
  for (const chat of chats) {
    const chatFile = path.join(__dirname, 'private', 'chats', chat.id, `${chat.id}.json`);
    
    try {
      // Get messages from cache or file (with validation)
      const messages = await getMessagesForUsers(chat.participants[0], chat.participants[1]);
      const messageIndex = messages.findIndex(msg => msg.id === messageId);
      
      if (messageIndex !== -1) {
        const message = messages[messageIndex];
        
        // Delete file if it's an image, video, document, or audio
        if (['image', 'video', 'document', 'audio'].includes(message.type)) {
          try {
            const filePath = getMessageFilePath(message, chat.id);
            if (filePath) {
              await fs.unlink(filePath);
              console.log(`Deleted file: ${filePath}`);
            }
          } catch (error) {
            console.error(`Error deleting file ${message.content}:`, error);
          }
        }
        
        // Remove message from array
        messages.splice(messageIndex, 1);
        await fs.writeFile(chatFile, JSON.stringify(messages, null, 2));
        
        // Update cache
        messageCache.set(chat.id, messages.slice());
        
        return { success: true, message };
      }
    } catch (error) {
      // Chat file doesn't exist or is corrupted, continue to next chat
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

// New function to approve a pending request
async function approveRequest(requestId, tier) {
  const requests = await loadJSON('private/requests/requests.json');
  const users = await loadJSON('private/users/users.json');
  
  const requestIndex = requests.findIndex(r => r.id === requestId);
  if (requestIndex === -1) {
    return { success: false, error: 'Request not found' };
  }
  
  const request = requests[requestIndex];
  
  // Check if username is already taken in users.json
  const existingUser = users.find(u => u.username === request.username);
  if (existingUser) {
    return { success: false, error: 'Username already taken' };
  }
  
  // Create user account with approved tier
  const newUser = {
    id: generateUserId(),
    username: request.username,
    password: request.password,
    tier: tier,
    role: 'user',
    banned: false,
    created: Date.now(),
    approvedAt: Date.now(),
    settings: {
      allowFriendRequests: true,
      allowNotifications: true
    }
  };
  
  users.push(newUser);
  await saveJSON('private/users/users.json', users);
  
  // Remove from pending requests
  requests.splice(requestIndex, 1);
  await saveJSON('private/requests/requests.json', requests);
  
  return { success: true, user: newUser };
}

// Send updated user lists helper
async function sendUpdatedUserLists(socket, userId) {
  try {
    const friends = await loadJSON('private/friends/friends.json');
    const chats = await loadJSON('private/chats.json');
    
    // Update friends list
    const userFriends = friends.filter(f => 
      (f.user1 === userId || f.user2 === userId) && f.status === 'accepted'
    );
    
    const userFriendsWithDetails = await Promise.all(
      userFriends.map(async (friendship) => {
        const friendId = friendship.user1 === userId ? friendship.user2 : friendship.user1;
        const friendUser = await getUserById(friendId);
        
        // Find the chat for this friendship to get lastMessage timestamp
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
    
    // Sort friends by lastMessage (most recent first)
    userFriendsWithDetails.sort((a, b) => b.lastMessage - a.lastMessage);
    
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
      
      // Fixed escalation system: 0→1min, 1→1min, 2+→1hour
      if (muteLevel === 0) {
        // First mute
        muteDuration = FIRST_MUTE_DURATION;
        reason = 'First spam mute (1 minute)';
      } else if (muteLevel === 1) {
        // Second mute
        muteDuration = FIRST_MUTE_DURATION;
        reason = 'Second spam mute (1 minute)';
      } else {
        // Third+ mute
        muteDuration = ESCALATED_MUTE_DURATION;
        reason = 'Repeated spam violation (1 hour)';
      }
      
      const muteEnd = now + muteDuration;
      saveMute(userId, muteEnd, reason, muteLevel);
      
      // Increment escalation level AFTER determining mute duration
      userLimits.escalationLevel++;
      
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

// Updated upload limit functions with persistent storage and 1-minute cooldowns
async function checkPictureLimit(userId, userRole) {
  // Owner has no limits
  if (userRole === 'owner') {
    return { allowed: true };
  }
  
  // Check for daily reset
  await checkAndResetDailyLimits();
  
  const now = Date.now();
  const userData = getUserUploadData(userId);
  
  // Check 1-minute cooldown
  if (now - userData.pictures.lastUpload < FILE_UPLOAD_COOLDOWN) {
    const secondsLeft = Math.ceil((FILE_UPLOAD_COOLDOWN - (now - userData.pictures.lastUpload)) / 1000);
    return { allowed: false, reason: `Please wait ${secondsLeft} seconds before uploading another picture` };
  }
  
  // Clean old uploads (24 hours)
  userData.pictures.dailyUploads = userData.pictures.dailyUploads.filter(time => now - time < 86400000);
  
  // Get user and determine tier
  const user = await getUserById(userId);
  const tier = user ? getUserTier(user) : 0;
  
  // If tier 0 (pending), deny access
  if (tier === 0) {
    return { allowed: false, reason: 'You need to purchase a subscription to upload pictures' };
  }
  
  const limit = TIER_LIMITS[tier].pictures;
  
  // Check daily limit
  if (userData.pictures.dailyUploads.length >= limit) {
    return { allowed: false, reason: `Daily picture limit reached (${limit} pictures per day)` };
  }
  
  userData.pictures.dailyUploads.push(now);
  userData.pictures.lastUpload = now;
  await saveUploadTracking();
  return { allowed: true };
}

async function checkVideoLimit(userId, userRole) {
  // Owner has no limits
  if (userRole === 'owner') {
    return { allowed: true };
  }
  
  // Check for daily reset
  await checkAndResetDailyLimits();
  
  const now = Date.now();
  const userData = getUserUploadData(userId);
  
  // Check 1-minute cooldown
  if (now - userData.videos.lastUpload < FILE_UPLOAD_COOLDOWN) {
    const secondsLeft = Math.ceil((FILE_UPLOAD_COOLDOWN - (now - userData.videos.lastUpload)) / 1000);
    return { allowed: false, reason: `Please wait ${secondsLeft} seconds before uploading another video` };
  }
  
  // Clean old uploads (24 hours)
  userData.videos.dailyUploads = userData.videos.dailyUploads.filter(time => now - time < 86400000);
  
  // Get user and determine tier
  const user = await getUserById(userId);
  const tier = user ? getUserTier(user) : 0;
  
  // If tier 0 (pending), deny access
  if (tier === 0) {
    return { allowed: false, reason: 'You need to purchase a subscription to upload videos' };
  }
  
  const limit = TIER_LIMITS[tier].videos;
  
  // Check daily limit
  if (userData.videos.dailyUploads.length >= limit) {
    return { allowed: false, reason: `Daily video limit reached (${limit} videos per day)` };
  }
  
  userData.videos.dailyUploads.push(now);
  userData.videos.lastUpload = now;
  await saveUploadTracking();
  return { allowed: true };
}

async function checkDocumentLimit(userId, userRole) {
  // Owner has no limits
  if (userRole === 'owner') {
    return { allowed: true };
  }
  
  // Check for daily reset
  await checkAndResetDailyLimits();
  
  const now = Date.now();
  const userData = getUserUploadData(userId);
  
  // Check 1-minute cooldown
  if (now - userData.documents.lastUpload < FILE_UPLOAD_COOLDOWN) {
    const secondsLeft = Math.ceil((FILE_UPLOAD_COOLDOWN - (now - userData.documents.lastUpload)) / 1000);
    return { allowed: false, reason: `Please wait ${secondsLeft} seconds before uploading another document` };
  }
  
  // Clean old uploads (24 hours)
  userData.documents.dailyUploads = userData.documents.dailyUploads.filter(time => now - time < 86400000);
  
  // Get user and determine tier
  const user = await getUserById(userId);
  const tier = user ? getUserTier(user) : 0;
  
  // If tier 0 (pending), deny access
  if (tier === 0) {
    return { allowed: false, reason: 'You need to purchase a subscription to upload documents' };
  }
  
  const limit = TIER_LIMITS[tier].documents;
  
  // Check daily limit
  if (userData.documents.dailyUploads.length >= limit) {
    return { allowed: false, reason: `Daily document limit reached (${limit} documents per day)` };
  }
  
  userData.documents.dailyUploads.push(now);
  userData.documents.lastUpload = now;
  await saveUploadTracking();
  return { allowed: true };
}

async function checkVoiceLimit(userId, userRole) {
  // Owner has no limits
  if (userRole === 'owner') {
    return { allowed: true };
  }
  
  // Check for daily reset
  await checkAndResetDailyLimits();
  
  const now = Date.now();
  const userData = getUserUploadData(userId);
  
  // Check 2-second cooldown (same as messages for spam prevention)
  if (now - userData.voice.lastUpload < VOICE_MESSAGE_COOLDOWN) {
    return { allowed: false, reason: 'Please wait 2 seconds between voice messages' };
  }
  
  // Clean old uploads (24 hours)
  userData.voice.dailyUploads = userData.voice.dailyUploads.filter(time => now - time < 86400000);
  
  // Get user and determine tier
  const user = await getUserById(userId);
  const tier = user ? getUserTier(user) : 0;
  
  // If tier 0 (pending), deny access
  if (tier === 0) {
    return { allowed: false, reason: 'You need to purchase a subscription to send voice messages' };
  }
  
  const limit = TIER_LIMITS[tier].voice;
  
  // Check daily limit
  if (userData.voice.dailyUploads.length >= limit) {
    return { allowed: false, reason: `Daily voice message limit reached (${limit} voice messages per day)` };
  }
  
  userData.voice.dailyUploads.push(now);
  userData.voice.lastUpload = now;
  await saveUploadTracking();
  return { allowed: true };
}

function checkUploadLimit(userId, isVideo = false, userRole = 'user') {
  // This function is no longer used as we have specific limits for each media type
  // Keeping it for compatibility, but it always returns allowed
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
        // First check if it's a pending request
        const pendingRequest = await getPendingRequestByUsername(username);
        if (pendingRequest && pendingRequest.password === password) {
          socket.emit('auth_error', 'PURCHASE_REQUIRED');
          return;
        }
        
        // Then check actual users
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
      
      // Check if user is approved (tier > 0)
      if (!isUserApproved(user)) {
        socket.emit('auth_error', 'PURCHASE_REQUIRED');
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
      
      // Load and send friends list with full user details - SORTED BY LAST MESSAGE
      const friends = await loadJSON('private/friends/friends.json');
      const chats = await loadJSON('private/chats.json');
      const userFriends = friends.filter(f => 
        (f.user1 === user.id || f.user2 === user.id) && f.status === 'accepted'
      );
      
      // Populate friend details with lastMessage for sorting
      const friendsWithDetails = await Promise.all(
        userFriends.map(async (friendship) => {
          const friendId = friendship.user1 === user.id ? friendship.user2 : friendship.user1;
          const friendUser = await getUserById(friendId);
          
          // Find the chat for this friendship to get lastMessage timestamp
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
      
      // Sort friends by lastMessage (most recent first)
      friendsWithDetails.sort((a, b) => b.lastMessage - a.lastMessage);
      
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
      
    } catch (error) {
      console.error('Authentication error:', error);
      socket.emit('auth_error', 'Server error');
    }
  });
  
  // Enhanced load_messages - loads ALL messages (max 250) with ghost message prevention
  socket.on('load_messages', async (data) => {
    try {
      if (!socket.userId) return;
      
      const user = await getUserById(socket.userId);
      if (!isUserApproved(user)) {
        socket.emit('message_error', 'You need to purchase a subscription to access messages');
        return;
      }
      
      const { friendId } = data;
      
      // Get validated messages (this will automatically clean up ghost messages)
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
      
      const currentUser = await getUserById(socket.userId);
      
      if (!currentUser) {
        socket.emit('message_error', 'User not found');
        return;
      }
      
      if (!isUserApproved(currentUser)) {
        socket.emit('message_error', 'You need to purchase a subscription to delete messages');
        return;
      }
      
      const { messageId } = data;
      
      // Find the message first to check permissions
      const chats = await loadJSON('private/chats.json');
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
      
      // Check if user can delete this message
      let canDelete = false;
      
      if (foundMessage.senderId === socket.userId) {
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
      
      const currentUser = await getUserById(socket.userId);
      if (!isUserApproved(currentUser)) {
        socket.emit('message_error', 'You need to purchase a subscription to send messages');
        return;
      }
      
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
      
      // Create message
      const message = {
        id: generateUserId(),
        senderId: socket.userId,
        receiverId,
        content,
        type: 'text',
        timestamp: Date.now()
      };
      
      // Save message to chat
      await saveMessageToChat(socket.userId, receiverId, message);
      
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
      
      const currentUser = await getUserById(socket.userId);
      if (!isUserApproved(currentUser)) {
        socket.emit('friend_request_error', 'You need to purchase a subscription to send friend requests');
        return;
      }
      
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
      
      // Check if target user is approved
      if (!isUserApproved(targetUser)) {
        socket.emit('friend_request_error', 'This user needs to purchase a subscription first');
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
      
      const currentUser = await getUserById(socket.userId);
      if (!isUserApproved(currentUser)) {
        socket.emit('friend_request_error', 'You need to purchase a subscription to respond to friend requests');
        return;
      }
      
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
      
      const currentUser = await getUserById(socket.userId);
      if (!isUserApproved(currentUser)) {
        socket.emit('message_error', 'You need to purchase a subscription to block users');
        return;
      }
      
      const { userId: targetUserId } = data;
      
      const friends = await loadJSON('private/friends/friends.json');
      
      // Delete all messages between the users immediately (including files and chat folder)
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
      
      const currentUser = await getUserById(socket.userId);
      if (!isUserApproved(currentUser)) {
        socket.emit('message_error', 'You need to purchase a subscription to unblock users');
        return;
      }
      
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
  
  // Updated settings handler with notifications support
  socket.on('update_settings', async (data) => {
    try {
      if (!socket.userId) return;
      
      const currentUser = await getUserById(socket.userId);
      if (!isUserApproved(currentUser)) {
        socket.emit('settings_error', 'You need to purchase a subscription to update settings');
        return;
      }
      
      const { allowFriendRequests, allowNotifications } = data;
      
      const users = await loadJSON('private/users/users.json');
      const userIndex = users.findIndex(u => u.id === socket.userId);
      
      if (userIndex === -1) {
        socket.emit('settings_error', 'User not found');
        return;
      }
      
      if (!users[userIndex].settings) {
        users[userIndex].settings = {};
      }
      
      // Update settings
      if (allowFriendRequests !== undefined) {
        users[userIndex].settings.allowFriendRequests = allowFriendRequests;
      }
      
      if (allowNotifications !== undefined) {
        users[userIndex].settings.allowNotifications = allowNotifications;
      }
      
      await saveJSON('private/users/users.json', users);
      
      socket.emit('settings_updated', { 
        allowFriendRequests: users[userIndex].settings.allowFriendRequests,
        allowNotifications: users[userIndex].settings.allowNotifications
      });
      
    } catch (error) {
      console.error('Settings update error:', error);
      socket.emit('settings_error', 'Failed to update settings');
    }
  });
  
  socket.on('logout', async () => {
    if (socket.userId) {
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
      activeUsers.delete(socket.userId);
    }
  });
});

// API Routes

// Updated registration route - saves to requests.json instead of users.json
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    // Check if username already exists in users.json
    const users = await loadJSON('private/users/users.json');
    if (users.find(u => u.username === username)) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    // Check if username already exists in pending requests
    const requests = await loadJSON('private/requests/requests.json');
    if (requests.find(r => r.username === username)) {
      return res.status(400).json({ error: 'Registration request already exists' });
    }
    
    // Create pending request
    const request = {
      id: generateUserId(),
      username,
      password, // In production, hash this password!
      created: Date.now(),
      status: 'pending'
    };
    
    requests.push(request);
    await saveJSON('private/requests/requests.json', requests);
    
    res.json({ 
      message: 'Registration request submitted successfully. You will be able to login once your account is approved.',
      status: 'pending'
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Enhanced upload endpoint that handles documents and voice messages with new persistent limits
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
    
    // Check user exists
    const users = await loadJSON('private/users/users.json');
    const user = users.find(u => u.id === userId);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid user' });
    }
    
    // Check if user is approved
    if (!isUserApproved(user)) {
      return res.status(403).json({ error: 'You need to purchase a subscription to upload files' });
    }
    
    const userTier = getUserTier(user);
    const isVideo = req.file.mimetype.startsWith('video/');
    const isImage = req.file.mimetype.startsWith('image/');
    const isDocument = req.file.mimetype === 'text/plain';
    const isAudio = req.file.mimetype === 'audio/webm'; // Only WebM audio
    
    // Check if user is muted
    if (await isUserMuted(userId)) {
      return res.status(403).json({ error: 'You are currently muted' });
    }
    
    // File size checks
    if (isDocument && req.file.size > MAX_DOCUMENT_SIZE) {
      return res.status(413).json({ error: `Document too large (${Math.round(req.file.size/1024)}KB / 50KB max)` });
    }
    
    if (isAudio && req.file.size > MAX_VOICE_SIZE) {
      return res.status(413).json({ error: `Voice message too large (${Math.round(req.file.size/(1024*1024))}MB / 2MB max)` });
    }
    
    // Audio file validation (WebM only)
    if (isAudio) {
      if (!validateWebM(req.file.buffer)) {
        return res.status(400).json({ error: 'Invalid WebM audio file or corrupted audio file' });
      }
    }
    
    // Check tier-based upload limits with new persistent system
    let limitCheck;
    
    if (isImage) {
      limitCheck = await checkPictureLimit(userId, user.role);
    } else if (isVideo) {
      limitCheck = await checkVideoLimit(userId, user.role);
    } else if (isDocument) {
      limitCheck = await checkDocumentLimit(userId, user.role);
    } else if (isAudio) {
      limitCheck = await checkVoiceLimit(userId, user.role);
    } else {
      return res.status(400).json({ error: 'Unknown file type' });
    }
    
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
    
    // All validations passed, now save the file to the chat's directory
    const chatId = generateChatId(userId, receiverId);
    
    // Ensure chat exists with proper directory structure
    await createChat(userId, receiverId);
    
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    let filename, mediaDir, messageType;
    
    if (isVideo) {
      filename = uniqueSuffix + path.extname(req.file.originalname);
      mediaDir = 'videos';
      messageType = 'video';
    } else if (isImage) {
      filename = uniqueSuffix + path.extname(req.file.originalname);
      mediaDir = 'pictures';
      messageType = 'image';
    } else if (isDocument) {
      filename = uniqueSuffix + '.txt';
      mediaDir = 'documents';
      messageType = 'document';
    } else if (isAudio) {
      filename = uniqueSuffix + '.webm';
      mediaDir = 'audios';
      messageType = 'audio';
    }
    
    // Create the full path to save the file in the chat's media directory
    savedFilePath = path.join(__dirname, 'private', 'chats', chatId, mediaDir, filename);
    
    await fs.writeFile(savedFilePath, req.file.buffer);
    
    // Create message record
    const message = {
      id: generateUserId(),
      senderId: userId,
      receiverId,
      content: filename,
      type: messageType,
      timestamp: Date.now()
    };
    
    // Save message to chat
    await saveMessageToChat(userId, receiverId, message);
    
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

// Enhanced media serving endpoint that searches through chat directories
app.get('/api/media/:filename', async (req, res) => {
  const filename = req.params.filename;
  
  try {
    // Get all chat directories
    const chatsDir = path.join(__dirname, 'private', 'chats');
    const chatIds = await fs.readdir(chatsDir);
    
    // Search through all chat directories for the file
    const mediaTypes = ['pictures', 'videos', 'documents', 'audios'];
    
    for (const chatId of chatIds) {
      for (const mediaType of mediaTypes) {
        const filePath = path.join(chatsDir, chatId, mediaType, filename);
        
        try {
          await fs.access(filePath);
          // File found, serve it
          res.sendFile(filePath);
          return;
        } catch {
          // File not found in this location, continue searching
          continue;
        }
      }
    }
    
    // File not found anywhere
    res.status(404).send('File not found');
    
  } catch (error) {
    console.error('Error serving media file:', error);
    res.status(500).send('Server error');
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

// Get pending requests
app.get('/api/admin/requests', async (req, res) => {
  try {
    const requests = await loadJSON('private/requests/requests.json');
    
    const requestsWithDetails = requests.map(request => {
      const createdDate = new Date(request.created);
      return {
        ...request,
        password: undefined, // Don't send passwords
        createdFormatted: createdDate.toLocaleString()
      };
    });
    
    res.json(requestsWithDetails);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve a pending request
app.post('/api/admin/requests/:requestId/approve', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { tier } = req.body;
    
    if (!tier || tier < 1 || tier > 3) {
      return res.status(400).json({ error: 'Invalid tier (must be 1, 2, or 3)' });
    }
    
    const result = await approveRequest(requestId, parseInt(tier));
    
    if (result.success) {
      res.json({ message: 'Request approved successfully', user: result.user });
    } else {
      res.status(400).json({ error: result.error });
    }
    
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Reject a pending request
app.post('/api/admin/requests/:requestId/reject', async (req, res) => {
  try {
    const { requestId } = req.params;
    
    const requests = await loadJSON('private/requests/requests.json');
    const requestIndex = requests.findIndex(r => r.id === requestId);
    
    if (requestIndex === -1) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    requests.splice(requestIndex, 1);
    await saveJSON('private/requests/requests.json', requests);
    
    res.json({ message: 'Request rejected successfully' });
    
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await loadJSON('private/users/users.json');
    const mutes = await loadJSON('private/mutes/mutes.json');
    
    // Add mute status to users
    const usersWithMuteStatus = users.map(user => {
      const activeMute = mutes.find(m => m.userId === user.id && m.muteEnd > Date.now());
      return {
        ...user,
        password: undefined, // Don't send passwords
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

// Fixed backup endpoint with proper error handling
app.get('/api/admin/backup', async (req, res) => {
  try {
    const archiveName = `pulsechat-backup-${new Date().toISOString().split('T')[0]}.zip`;
    
    // Check if private directory exists
    try {
      await fs.access(path.join(__dirname, 'private'));
    } catch (error) {
      return res.status(404).json({ error: 'No data to backup' });
    }
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);
    
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });
    
    // Handle archive errors before piping
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create backup' });
      }
    });
    
    // Pipe archive data to the response
    archive.pipe(res);
    
    // Add the entire private directory to the archive
    archive.directory(path.join(__dirname, 'private'), false);
    
    // Finalize the archive
    await archive.finalize();
    
  } catch (error) {
    console.error('Backup error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create backup' });
    }
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const mutes = await loadJSON('private/mutes/mutes.json');
    const activeMutes = mutes.filter(m => m.muteEnd > Date.now());
    const requests = await loadJSON('private/requests/requests.json');
    
    res.json({
      activeUsers: activeUsers.size,
      maxUsers: MAX_ACTIVE_USERS,
      mutedUsers: activeMutes.length,
      pendingRequests: requests.length
    });
  } catch (error) {
    res.json({
      activeUsers: activeUsers.size,
      maxUsers: MAX_ACTIVE_USERS,
      mutedUsers: 0,
      pendingRequests: 0
    });
  }
});

// Manual cleanup endpoint for admins
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

// New API endpoints for notifications setting
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
    
    res.json({
      allowFriendRequests: user.settings?.allowFriendRequests ?? true,
      allowNotifications: user.settings?.allowNotifications ?? true
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

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Enhanced cleanup routines - now runs every 30 minutes
setInterval(async () => {
  console.log('Running scheduled cleanup...');
  await cleanupOldSessions();
  await cleanupExpiredMutes();
  await cleanupOldMessages();  // Clean up old messages
  await cleanupOrphanedMediaFiles();  // Clean up orphaned files
  await checkAndResetDailyLimits(); // Check for daily limit resets
}, 30 * 60 * 1000); // Run every 30 minutes

// Initialize and start server
async function start() {
  await initializeDirectories();
  
  server.listen(PORT, () => {
    console.log(`PulseChat server running on port ${PORT}`);
    console.log(`Admin API key: ${ADMIN_API_KEY}`);
    console.log(`Max active users: ${MAX_ACTIVE_USERS}`);
    console.log(`Message retention: 48 hours`);
    console.log(`Max messages per chat: ${MAX_MESSAGES_PER_CHAT}`);
    console.log(`File upload cooldown: 1 minute (pictures, videos, documents)`);
    console.log(`Voice message cooldown: 2 seconds`);
    console.log(`Max document size: 50KB`);
    console.log(`Max voice message size: 2MB`);
    console.log(`NEW TIER SYSTEM - NO FREE TIER:`);
    console.log(`  Tier 1 (€100): ${TIER_LIMITS[1].pictures} pics, ${TIER_LIMITS[1].videos} videos, ${TIER_LIMITS[1].documents} docs, ${TIER_LIMITS[1].voice} voice/day`);
    console.log(`  Tier 2 (€150): ${TIER_LIMITS[2].pictures} pics, ${TIER_LIMITS[2].videos} videos, ${TIER_LIMITS[2].documents} docs, ${TIER_LIMITS[2].voice} voice/day`);
    console.log(`  Tier 3 (€200): ${TIER_LIMITS[3].pictures} pics, ${TIER_LIMITS[3].videos} videos, ${TIER_LIMITS[3].documents} docs, ${TIER_LIMITS[3].voice} voice/day`);
    console.log(`Audio format: WebM only`);
    console.log(`Ghost message prevention: ENABLED`);
    console.log(`File structure: Chat-centric organization`);
    console.log(`Upload tracking: Persistent (private/cooldowns/upload_tracking.json)`);
    console.log(`Daily reset: Automatic at midnight`);
    console.log(`Admin/Developer/Owner roles: Tier 3 privileges`);
    console.log(`PENDING REQUESTS: Users register to private/requests/requests.json until approved`);
    console.log(`TIER 0 BLOCKING: Unapproved users cannot chat, upload, or do anything until given a tier`);
  });
}

start();