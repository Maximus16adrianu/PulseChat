// ===== PulseChat Application =====

// Global State
const PulseChat = {
    socket: null,
    currentUser: null,
    selectedFriend: null,
    friends: [],
    friendRequests: [],
    blockedUsers: [],
    messages: [],
    friendRequestsVisible: true,
    userToBan: null,
    currentSettingsTab: 'profile',
    
    // Message input focus detection for notifications
    isMessageInputFocused: false,
    
    // Connection state tracking
    connectionState: {
        wasBackgrounded: false,
        lastActivity: Date.now(),
        isReconnecting: false
    },
    
    // Server-relayed voice calling state (UPDATED)
    currentCall: null,
    localStream: null,
    audioContext: null,
    audioProcessor: null,
    remoteAudio: null,
    callTimer: null,
    callStartTime: null,
    isCallMuted: false,
    isSpeakerOn: false,
    audioChunksBuffer: [],
    
    // UI Elements Cache
    elements: {
        // Audio elements
        notificationSound: null, // Will be created dynamically
        
        // Call UI Elements
        activeCallOverlay: document.getElementById('activeCallOverlay'),
        incomingCallModal: document.getElementById('incomingCallModal'),
        callAvatar: document.getElementById('callAvatar'),
        callUserName: document.getElementById('callUserName'),
        callStatus: document.getElementById('callStatus'),
        callTimer: document.getElementById('callTimer'),
        callTimeRemaining: document.getElementById('callTimeRemaining'),
        callTimeLeft: document.getElementById('callTimeLeft'),
        muteBtn: document.getElementById('muteBtn'),
        endCallBtn: document.getElementById('endCallBtn'),
        speakerBtn: document.getElementById('speakerBtn'),
        incomingCallAvatar: document.getElementById('incomingCallAvatar'),
        incomingCallUserName: document.getElementById('incomingCallUserName'),
        callBtn: document.getElementById('callBtn'),
        mobileCallBtn: document.getElementById('mobileCallBtn'),
        
        // Mobile Navigation
        mobileNavOverlay: document.getElementById('mobileNavOverlay'),
        mobileMenuBtn: document.getElementById('mobileMenuBtn'),
        mobileNavClose: document.getElementById('mobileNavClose'),
        mobileFriendsList: document.getElementById('mobileFriendsList'),
        mobileFriendRequestsList: document.getElementById('mobileFriendRequestsList'),
        mobileFriendRequestsBadge: document.getElementById('mobileFriendRequestsBadge'),
        mobileFriendRequestsToggle: document.getElementById('mobileFriendRequestsToggle'),
        
        // Mobile User Header & Modal
        mobileUserHeader: document.getElementById('mobileUserHeader'),
        mobileHeaderAvatar: document.getElementById('mobileHeaderAvatar'),
        mobileHeaderName: document.getElementById('mobileHeaderName'),
        mobileHeaderStatus: document.getElementById('mobileHeaderStatus'),
        mobileUserInfoModal: document.getElementById('mobileUserInfoModal'),
        mobileUserAvatar: document.getElementById('mobileUserAvatar'),
        mobileUserName: document.getElementById('mobileUserName'),
        mobileUserRole: document.getElementById('mobileUserRole'),
        mobileFriendsSinceDate: document.getElementById('mobileFriendsSinceDate'),
        mobileFriendTier: document.getElementById('mobileFriendTier'),
        mobileFriendRoleInfo: document.getElementById('mobileFriendRoleInfo'),
        mobileBlockBtn: document.getElementById('mobileBlockBtn'),
        mobileAdminActions: document.getElementById('mobileAdminActions'),
        mobileMuteDuration: document.getElementById('mobileMuteDuration'),
        
        // Modals
        loginModal: document.getElementById('loginModal'),
        registerModal: document.getElementById('registerModal'),
        friendsManagementModal: document.getElementById('friendsManagementModal'),
        settingsModal: document.getElementById('settingsModal'),
        banReasonModal: document.getElementById('banReasonModal'),
        autoLoginIndicator: document.getElementById('autoLoginIndicator'),
        
        // Connection recovery overlay
        reconnectOverlay: null, // Will be created dynamically
        
        // Main App
        mainApp: document.getElementById('mainApp'),
        desktopSidebar: document.getElementById('desktopSidebar'),
        
        // Chat Elements
        chatTitle: document.getElementById('chatTitle'),
        messagesContainer: document.getElementById('messagesContainer'),
        messageInput: document.getElementById('messageInput'),
        sendBtn: document.getElementById('sendBtn'),
        uploadBtn: document.getElementById('uploadBtn'),
        fileInput: document.getElementById('fileInput'),
        
        // User Info
        currentUsername: document.getElementById('currentUsername'),
        userRole: document.getElementById('userRole'),
        userInfoPanel: document.getElementById('userInfoPanel'),
        friendAvatar: document.getElementById('friendAvatar'),
        friendInfoUsername: document.getElementById('friendInfoUsername'),
        friendInfoRole: document.getElementById('friendInfoRole'),
        friendsSinceDate: document.getElementById('friendsSinceDate'),
        friendTier: document.getElementById('friendTier'),
        friendRoleInfo: document.getElementById('friendRoleInfo'),
        
        // Friends
        friendsList: document.getElementById('friendsList'),
        friendRequestsList: document.getElementById('friendRequestsList'),
        friendRequestsBadge: document.getElementById('friendRequestsBadge'),
        friendRequestsToggle: document.getElementById('friendRequestsToggle'),
        
        // Forms
        username: document.getElementById('username'),
        password: document.getElementById('password'),
        regUsername: document.getElementById('regUsername'),
        regPassword: document.getElementById('regPassword'),
        friendUsername: document.getElementById('friendUsername'),
        allowFriendRequests: document.getElementById('allowFriendRequests'),
        allowNotifications: document.getElementById('allowNotifications'),
        allowCalls: document.getElementById('allowCalls'),
        banReason: document.getElementById('banReason'),
        muteDuration: document.getElementById('muteDuration'),
        
        // Settings Profile Elements
        profileUsername: document.getElementById('profileUsername'),
        profileTier: document.getElementById('profileTier'),
        profileRole: document.getElementById('profileRole'),
        profileCallTime: document.getElementById('profileCallTime'),
        tierBenefitsList: document.getElementById('tierBenefitsList'),
        
        // Settings Tab Elements
        profileTab: document.getElementById('profileTab'),
        preferencesTab: document.getElementById('preferencesTab'),
        aboutTab: document.getElementById('aboutTab'),
        
        // Message displays
        authMessage: document.getElementById('authMessage'),
        regMessage: document.getElementById('regMessage'),
        friendMessage: document.getElementById('friendMessage'),
        settingsMessage: document.getElementById('settingsMessage'),
        
        // Other
        blockedUsersList: document.getElementById('blockedUsersList'),
        adminActions: document.getElementById('adminActions'),
        notificationContainer: document.getElementById('notificationContainer')
    }
};

// ===== Server-Relayed Voice Calling Functions (UPDATED) =====

// Audio processing constants (32kbps server-relayed)
const AUDIO_SAMPLE_RATE = 16000; // 16kHz
const AUDIO_BITRATE = 32000; // 32kbps
const AUDIO_CHUNK_SIZE = 1024; // bytes per chunk
const AUDIO_CHUNK_INTERVAL = 20; // ms between chunks

async function setupServerRelayedAudio() {
    try {
        // Get user media for server-relayed audio
        PulseChat.localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: AUDIO_SAMPLE_RATE,
                channelCount: 1 // Mono for bandwidth efficiency
            }, 
            video: false 
        });
        
        // Create audio context for processing
        PulseChat.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: AUDIO_SAMPLE_RATE
        });
        
        // Create audio source from microphone
        const source = PulseChat.audioContext.createMediaStreamSource(PulseChat.localStream);
        
        // Create script processor for audio chunks
        PulseChat.audioProcessor = PulseChat.audioContext.createScriptProcessor(1024, 1, 1);
        
        // Process audio chunks and send to server
        PulseChat.audioProcessor.onaudioprocess = function(event) {
            if (!PulseChat.currentCall || PulseChat.isCallMuted) return;
            
            const inputBuffer = event.inputBuffer.getChannelData(0);
            
            // Convert float32 audio to int16 for bandwidth efficiency
            const int16Buffer = new Int16Array(inputBuffer.length);
            for (let i = 0; i < inputBuffer.length; i++) {
                int16Buffer[i] = Math.max(-32768, Math.min(32767, inputBuffer[i] * 32768));
            }
            
            // Send audio chunk to server for relay
            if (PulseChat.socket && PulseChat.currentCall) {
                PulseChat.socket.emit('audio_stream', {
                    callId: PulseChat.currentCall.id,
                    audioData: Array.from(int16Buffer)
                });
            }
        };
        
        // Connect audio processing chain
        source.connect(PulseChat.audioProcessor);
        PulseChat.audioProcessor.connect(PulseChat.audioContext.destination);
        
        // Create remote audio element for playback
        PulseChat.remoteAudio = document.createElement('audio');
        PulseChat.remoteAudio.autoplay = true;
        PulseChat.remoteAudio.id = 'remoteAudio';
        document.body.appendChild(PulseChat.remoteAudio);
        
        return true;
        
    } catch (error) {
        console.error('Error setting up server-relayed audio:', error);
        throw new Error('Could not access microphone. Please check permissions.');
    }
}

function processIncomingAudio(audioData) {
    if (!PulseChat.audioContext || !PulseChat.remoteAudio || !audioData) return;
    
    try {
        // Convert int16 array back to float32
        const float32Buffer = new Float32Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
            float32Buffer[i] = audioData[i] / 32768;
        }
        
        // Create audio buffer
        const audioBuffer = PulseChat.audioContext.createBuffer(1, float32Buffer.length, AUDIO_SAMPLE_RATE);
        audioBuffer.getChannelData(0).set(float32Buffer);
        
        // Create buffer source and play
        const source = PulseChat.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(PulseChat.audioContext.destination);
        source.start();
        
    } catch (error) {
        console.error('Error processing incoming audio:', error);
    }
}

function initiateCall() {
    if (!PulseChat.selectedFriend) {
        showNotification('Please select a friend to call', 'error');
        return;
    }
    
    if (PulseChat.currentCall) {
        showNotification('You are already in a call', 'error');
        return;
    }
    
    PulseChat.socket.emit('initiate_call', {
        friendId: PulseChat.selectedFriend.friendId
    });
}

function answerCall(accept) {
    if (!PulseChat.currentCall) return;
    
    PulseChat.socket.emit('answer_call', {
        callId: PulseChat.currentCall.id,
        accept: accept
    });
    
    hideModal(PulseChat.elements.incomingCallModal);
    
    if (!accept) {
        cleanupCall();
    }
}

function endCall() {
    if (PulseChat.currentCall) {
        PulseChat.socket.emit('end_call', {
            callId: PulseChat.currentCall.id
        });
    }
    cleanupCall();
}

function cleanupCall() {
    // Stop call timer
    if (PulseChat.callTimer) {
        clearInterval(PulseChat.callTimer);
        PulseChat.callTimer = null;
    }
    
    // Clean up server-relayed audio
    if (PulseChat.localStream) {
        PulseChat.localStream.getTracks().forEach(track => track.stop());
        PulseChat.localStream = null;
    }
    
    if (PulseChat.audioProcessor) {
        PulseChat.audioProcessor.disconnect();
        PulseChat.audioProcessor = null;
    }
    
    if (PulseChat.audioContext) {
        PulseChat.audioContext.close();
        PulseChat.audioContext = null;
    }
    
    // Remove remote audio element
    if (PulseChat.remoteAudio) {
        PulseChat.remoteAudio.remove();
        PulseChat.remoteAudio = null;
    }
    
    // Reset call state
    PulseChat.currentCall = null;
    PulseChat.callStartTime = null;
    PulseChat.isCallMuted = false;
    PulseChat.isSpeakerOn = false;
    PulseChat.audioChunksBuffer = [];
    
    // Hide call UI
    PulseChat.elements.activeCallOverlay.classList.add('hidden');
    hideModal(PulseChat.elements.incomingCallModal);
    
    // Reset call button states
    updateCallButtonStates();
}

function toggleMute() {
    if (!PulseChat.currentCall) return;
    
    PulseChat.isCallMuted = !PulseChat.isCallMuted;
    
    // Send mute state to server
    if (PulseChat.socket) {
        PulseChat.socket.emit('audio_settings', {
            callId: PulseChat.currentCall.id,
            muted: PulseChat.isCallMuted,
            volume: PulseChat.isSpeakerOn ? 1.0 : 0.8
        });
    }
    
    updateCallButtonStates();
}

function toggleSpeaker() {
    PulseChat.isSpeakerOn = !PulseChat.isSpeakerOn;
    
    // Adjust remote audio volume
    if (PulseChat.remoteAudio) {
        PulseChat.remoteAudio.volume = PulseChat.isSpeakerOn ? 1.0 : 0.8;
    }
    
    // Send speaker state to server
    if (PulseChat.socket && PulseChat.currentCall) {
        PulseChat.socket.emit('audio_settings', {
            callId: PulseChat.currentCall.id,
            muted: PulseChat.isCallMuted,
            volume: PulseChat.isSpeakerOn ? 1.0 : 0.8
        });
    }
    
    updateCallButtonStates();
}

function updateCallButtonStates() {
    if (PulseChat.elements.muteBtn) {
        PulseChat.elements.muteBtn.classList.toggle('active', PulseChat.isCallMuted);
        PulseChat.elements.muteBtn.title = PulseChat.isCallMuted ? 'Unmute' : 'Mute';
    }
    
    if (PulseChat.elements.speakerBtn) {
        PulseChat.elements.speakerBtn.classList.toggle('active', PulseChat.isSpeakerOn);
        PulseChat.elements.speakerBtn.title = PulseChat.isSpeakerOn ? 'Disable Speaker' : 'Enable Speaker';
    }
}

function updateCallStatus(status) {
    if (PulseChat.elements.callStatus) {
        setSafeTextContent(PulseChat.elements.callStatus, status);
    }
}

function startCallTimer() {
    if (PulseChat.callTimer) {
        clearInterval(PulseChat.callTimer);
    }
    
    PulseChat.callStartTime = Date.now();
    
    PulseChat.callTimer = setInterval(() => {
        if (!PulseChat.callStartTime) return;
        
        const elapsed = Date.now() - PulseChat.callStartTime;
        const minutes = Math.floor(elapsed / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        
        const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        if (PulseChat.elements.callTimer) {
            setSafeTextContent(PulseChat.elements.callTimer, timeString);
            PulseChat.elements.callTimer.classList.remove('hidden');
        }
    }, 1000);
}

function formatCallTime(milliseconds) {
    if (milliseconds === -1) return 'Unlimited';
    if (milliseconds === 0) return '00:00';
    
    const totalMinutes = Math.floor(milliseconds / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

function updateCallTimeDisplay(remainingTime) {
    if (PulseChat.elements.profileCallTime) {
        const timeText = formatCallTime(remainingTime);
        setSafeTextContent(PulseChat.elements.profileCallTime, timeText);
        
        // Update badge styling based on remaining time
        const badge = PulseChat.elements.profileCallTime;
        badge.classList.remove('unlimited', 'low', 'critical');
        
        if (remainingTime === -1) {
            badge.classList.add('unlimited');
        } else if (remainingTime < 1800000) { // Less than 30 minutes
            badge.classList.add('critical');
        } else if (remainingTime < 3600000) { // Less than 1 hour
            badge.classList.add('low');
        }
    }
    
    if (PulseChat.elements.callTimeLeft) {
        setSafeTextContent(PulseChat.elements.callTimeLeft, formatCallTime(remainingTime));
    }
}

function updateCallAvailability() {
    const canCall = PulseChat.currentUser && 
                   PulseChat.selectedFriend && 
                   !PulseChat.currentCall &&
                   PulseChat.currentUser.settings?.allowCalls !== false;
    
    if (PulseChat.elements.callBtn) {
        PulseChat.elements.callBtn.disabled = !canCall;
    }
    
    if (PulseChat.elements.mobileCallBtn) {
        PulseChat.elements.mobileCallBtn.disabled = !canCall;
    }
}

// ===== Message Input Focus Detection =====

function setupMessageInputFocusDetection() {
    const messageInput = PulseChat.elements.messageInput;
    
    if (messageInput) {
        messageInput.addEventListener('focus', function() {
            PulseChat.isMessageInputFocused = true;
        });
        
        messageInput.addEventListener('blur', function() {
            PulseChat.isMessageInputFocused = false;
        });
    }
}

// ===== Notification Sound Functions =====

function createNotificationSound() {
    const audio = document.createElement('audio');
    audio.src = '/sounds/notification.mp3';
    audio.preload = 'auto';
    PulseChat.elements.notificationSound = audio;
}

function playNotificationSound() {
    // Only play if notifications are enabled and message input is not focused
    if (!PulseChat.currentUser || 
        !PulseChat.currentUser.settings || 
        PulseChat.currentUser.settings.allowNotifications === false ||
        PulseChat.isMessageInputFocused) {
        return;
    }
    
    try {
        if (PulseChat.elements.notificationSound) {
            // Reset audio to beginning and play
            PulseChat.elements.notificationSound.currentTime = 0;
            PulseChat.elements.notificationSound.play().catch(error => {
                // Ignore play errors (user hasn't interacted with page yet, etc.)
                console.log('Could not play notification sound:', error);
            });
        }
    } catch (error) {
        console.log('Error playing notification sound:', error);
    }
}

// ===== Security Functions =====

// Enhanced HTML escaping with additional security measures
function escapeHtml(text) {
    if (text === null || text === undefined) {
        return '';
    }
    
    // Convert to string if not already
    const str = String(text);
    
    // Use textContent approach for basic escaping
    const div = document.createElement('div');
    div.textContent = str;
    let escaped = div.innerHTML;
    
    // Additional escaping for common XSS vectors
    escaped = escaped
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
    
    return escaped;
}

// Sanitize and validate user input
function sanitizeInput(input, maxLength = 1000) {
    if (typeof input !== 'string') {
        return '';
    }
    
    // Trim whitespace
    let sanitized = input.trim();
    
    // Limit length to prevent potential DoS
    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength);
    }
    
    // Remove any null bytes or control characters except newlines and tabs
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    
    return sanitized;
}

// Create safe text node (never executes scripts)
function createSafeTextNode(text) {
    const sanitized = sanitizeInput(text);
    return document.createTextNode(sanitized);
}

// Safe way to set text content
function setSafeTextContent(element, text) {
    if (!element) return;
    
    // Clear any existing content
    element.textContent = '';
    
    // Add sanitized text
    const sanitized = sanitizeInput(text);
    element.textContent = sanitized;
}

// Safe way to set HTML content with escaped user data
function setSafeHTML(element, htmlTemplate, userDataReplacements = {}) {
    if (!element) return;
    
    let safeHTML = htmlTemplate;
    
    // Replace all user data placeholders with escaped content
    for (const [placeholder, userData] of Object.entries(userDataReplacements)) {
        const escapedData = escapeHtml(userData);
        safeHTML = safeHTML.replace(new RegExp(placeholder, 'g'), escapedData);
    }
    
    element.innerHTML = safeHTML;
}

// Validate and sanitize message content
function sanitizeMessage(content) {
    const sanitized = sanitizeInput(content, 5000); // Max 5000 chars for messages
    
    // Additional validation for message content
    if (sanitized.length === 0) {
        return null;
    }
    
    // Check for suspicious patterns that might indicate script injection attempts
    const suspiciousPatterns = [
        /<script/i,
        /javascript:/i,
        /on\w+\s*=/i,
        /<iframe/i,
        /<object/i,
        /<embed/i,
        /<link/i,
        /<meta/i,
        /data:text\/html/i,
        /vbscript:/i
    ];
    
    for (const pattern of suspiciousPatterns) {
        if (pattern.test(sanitized)) {
            console.warn('Suspicious content detected and filtered');
            // Return sanitized version with suspicious content removed
            return sanitized.replace(pattern, '[FILTERED]');
        }
    }
    
    return sanitized;
}

// Safe URL validation for media content
function isValidMediaUrl(url) {
    try {
        const urlObj = new URL(url, window.location.origin);
        // Only allow same-origin URLs for media
        return urlObj.origin === window.location.origin && 
               urlObj.pathname.startsWith('/api/media/');
    } catch {
        return false;
    }
}

// ===== Friends List Reordering Functions =====

function moveSelectedFriendToTop() {
    if (!PulseChat.selectedFriend || PulseChat.friends.length <= 1) return;
    
    const friendIndex = PulseChat.friends.findIndex(
        friend => friend.friendId === PulseChat.selectedFriend.friendId
    );
    
    if (friendIndex > 0) { // Only move if not already at top
        // Remove friend from current position
        const friendToMove = PulseChat.friends.splice(friendIndex, 1)[0];
        
        // Add to beginning of array
        PulseChat.friends.unshift(friendToMove);
        
        // Re-render both lists
        renderFriendsList();
        renderMobileFriendsList();
    }
}

function moveFriendToTopByMessage(message) {
    if (PulseChat.friends.length <= 1) return;
    
    // Determine which friend to move based on the message
    let friendIdToMove = null;
    
    if (message.senderId === PulseChat.currentUser.id) {
        // We sent the message, move the receiver to top
        friendIdToMove = message.receiverId;
    } else {
        // We received the message, move the sender to top
        friendIdToMove = message.senderId;
    }
    
    if (!friendIdToMove) return;
    
    const friendIndex = PulseChat.friends.findIndex(
        friend => friend.friendId === friendIdToMove
    );
    
    if (friendIndex > 0) { // Only move if not already at top
        // Remove friend from current position
        const friendToMove = PulseChat.friends.splice(friendIndex, 1)[0];
        
        // Add to beginning of array
        PulseChat.friends.unshift(friendToMove);
        
        // Re-render both lists
        renderFriendsList();
        renderMobileFriendsList();
        
        // Update selectedFriend reference if it was moved
        if (PulseChat.selectedFriend && PulseChat.selectedFriend.friendId === friendIdToMove) {
            PulseChat.selectedFriend = friendToMove;
        }
    }
}

// ===== Connection Recovery System =====

function createReconnectOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'reconnectOverlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    
    overlay.innerHTML = `
        <div style="text-align: center;">
            <div style="
                width: 50px;
                height: 50px;
                border: 3px solid #333;
                border-top: 3px solid #007bff;
                border-radius: 50%;
                margin: 0 auto 20px;
                animation: spin 1s linear infinite;
            "></div>
            <h3 style="margin: 0 0 10px; font-size: 18px; font-weight: 600;">Reconnecting...</h3>
            <p style="margin: 0; opacity: 0.8; font-size: 14px;">Re-establishing connection</p>
        </div>
        <style>
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        </style>
    `;
    
    document.body.appendChild(overlay);
    PulseChat.elements.reconnectOverlay = overlay;
}

function showReconnectOverlay() {
    if (!PulseChat.elements.reconnectOverlay) {
        createReconnectOverlay();
    }
    PulseChat.elements.reconnectOverlay.style.display = 'flex';
}

function hideReconnectOverlay() {
    if (PulseChat.elements.reconnectOverlay) {
        PulseChat.elements.reconnectOverlay.style.display = 'none';
    }
}

function shouldReconnect() {
    // Check if we were backgrounded and it's been a while
    const now = Date.now();
    const timeSinceBackground = now - PulseChat.connectionState.lastActivity;
    
    return PulseChat.connectionState.wasBackgrounded && 
           timeSinceBackground > 30000 && // 30 seconds
           !PulseChat.connectionState.isReconnecting &&
           PulseChat.currentUser; // Only if we were logged in
}

function fullReconnect() {
    if (PulseChat.connectionState.isReconnecting) return;
    
    console.log('Starting full reconnection...');
    PulseChat.connectionState.isReconnecting = true;
    
    showReconnectOverlay();
    
    // Clear current state
    PulseChat.selectedFriend = null;
    PulseChat.friends = [];
    PulseChat.friendRequests = [];
    PulseChat.blockedUsers = [];
    PulseChat.messages = [];
    
    // End any active calls
    if (PulseChat.currentCall) {
        cleanupCall();
    }
    
    // Disconnect old socket
    if (PulseChat.socket) {
        PulseChat.socket.disconnect();
        PulseChat.socket = null;
    }
    
    // Wait a bit, then reinitialize
    setTimeout(() => {
        initializeSocket();
        
        // Try to re-authenticate
        const sessionToken = getCookie('pulsechat_session');
        if (sessionToken && PulseChat.socket) {
            PulseChat.socket.emit('authenticate', { sessionToken });
        } else {
            // No valid session, hide overlay and show login
            PulseChat.connectionState.isReconnecting = false;
            hideReconnectOverlay();
            PulseChat.currentUser = null;
            PulseChat.elements.mainApp.classList.add('hidden');
            showLogin();
        }
    }, 1000);
}

// ===== Background/Foreground Detection =====

function setupVisibilityHandling() {
    // Page Visibility API
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            PulseChat.connectionState.wasBackgrounded = true;
            PulseChat.connectionState.lastActivity = Date.now();
        } else {
            // Coming back to foreground
            if (shouldReconnect()) {
                fullReconnect();
            }
            PulseChat.connectionState.wasBackgrounded = false;
        }
    });
    
    // Window focus/blur as backup
    window.addEventListener('blur', function() {
        PulseChat.connectionState.wasBackgrounded = true;
        PulseChat.connectionState.lastActivity = Date.now();
    });
    
    window.addEventListener('focus', function() {
        if (shouldReconnect()) {
            fullReconnect();
        }
        PulseChat.connectionState.wasBackgrounded = false;
    });
    
    // Page hide/show for mobile
    window.addEventListener('pagehide', function() {
        PulseChat.connectionState.wasBackgrounded = true;
        PulseChat.connectionState.lastActivity = Date.now();
    });
    
    window.addEventListener('pageshow', function(event) {
        if (event.persisted && shouldReconnect()) {
            fullReconnect();
        }
    });
}

// ===== Socket Initialization =====

function initializeSocket() {
    PulseChat.socket = io();
    setupSocketHandlers();
}

function setupSocketHandlers() {
    // Connection Events
    PulseChat.socket.on('connect', () => {
        console.log('Socket connected');
    });
    
    PulseChat.socket.on('disconnect', () => {
        console.log('Socket disconnected');
    });
    
    // Authentication Events
    PulseChat.socket.on('authenticated', (data) => {
        PulseChat.currentUser = data.user;
        PulseChat.connectionState.isReconnecting = false;
        
        hideModal(PulseChat.elements.loginModal);
        hideModal(PulseChat.elements.autoLoginIndicator);
        hideReconnectOverlay();
        PulseChat.elements.mainApp.classList.remove('hidden');
        
        // Update user info display safely
        setSafeTextContent(PulseChat.elements.currentUsername, PulseChat.currentUser.username);
        
        // Show role badge if applicable
        if (['admin', 'owner', 'developer'].includes(PulseChat.currentUser.role)) {
            const roleBadge = PulseChat.elements.userRole;
            setSafeTextContent(roleBadge, PulseChat.currentUser.role);
            roleBadge.className = `role-badge ${escapeHtml(PulseChat.currentUser.role)}`;
            roleBadge.classList.remove('hidden');
        }
        
        // Update call time display
        if (data.callTimeRemaining !== undefined) {
            updateCallTimeDisplay(data.callTimeRemaining);
        }
        
        // Update profile tab if it's visible
        if (PulseChat.currentSettingsTab === 'profile') {
            updateProfileTab();
        }
        
        // Reset chat UI to empty state
        PulseChat.elements.userInfoPanel.classList.add('hidden');
        PulseChat.elements.mobileUserHeader.classList.add('hidden');
        PulseChat.elements.messagesContainer.innerHTML = `
            <div class="empty-state">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <h3>Select a friend to view your conversation</h3>
            </div>
        `;
        setSafeTextContent(PulseChat.elements.chatTitle, 'Select a friend to start chatting');
        disableInputs();
        updateCallAvailability();
    });

    PulseChat.socket.on('session_token', (token) => {
        setCookie('pulsechat_session', token, 30); // 30 days
    });

    PulseChat.socket.on('auth_error', (message) => {
        PulseChat.connectionState.isReconnecting = false;
        hideModal(PulseChat.elements.autoLoginIndicator);
        hideReconnectOverlay();
        showMessage('authMessage', message, 'error');
        deleteCookie('pulsechat_session');
        PulseChat.currentUser = null;
    });

    PulseChat.socket.on('banned', (data) => {
        const sanitizedReason = sanitizeInput(data.reason || 'No reason provided');
        alert(`You have been banned. Reason: ${sanitizedReason}`);
        deleteCookie('pulsechat_session');
        location.reload();
    });

    PulseChat.socket.on('muted', (data) => {
        const sanitizedDuration = sanitizeInput(data.duration || 'indefinite');
        const sanitizedReason = sanitizeInput(data.reason || 'No reason provided');
        showNotification(`You have been muted for ${sanitizedDuration}. Reason: ${sanitizedReason}`, 'error');
    });

    // Server-Relayed Voice Calling Events (UPDATED)
    PulseChat.socket.on('incoming_call', (data) => {
        if (PulseChat.currentCall) {
            // Already in a call, automatically decline
            PulseChat.socket.emit('answer_call', {
                callId: data.callId,
                accept: false
            });
            return;
        }
        
        PulseChat.currentCall = {
            id: data.callId,
            type: 'incoming',
            callerUsername: data.callerUsername,
            callerId: data.callerId,
            serverRelayed: data.serverRelayed || false
        };
        
        // Update incoming call modal
        setSafeTextContent(PulseChat.elements.incomingCallAvatar, data.callerUsername.charAt(0).toUpperCase());
        setSafeTextContent(PulseChat.elements.incomingCallUserName, data.callerUsername);
        
        // Show incoming call modal
        showModal(PulseChat.elements.incomingCallModal);
        
        // Play ringtone sound if available
        playNotificationSound();
    });
    
    PulseChat.socket.on('call_initiated', (data) => {
        if (!PulseChat.selectedFriend) return;
        
        PulseChat.currentCall = {
            id: data.callId,
            type: 'outgoing',
            friendUsername: PulseChat.selectedFriend.friendUsername,
            friendId: PulseChat.selectedFriend.friendId,
            serverRelayed: data.serverRelayed || false
        };
        
        // Update call overlay
        setSafeTextContent(PulseChat.elements.callAvatar, PulseChat.selectedFriend.friendUsername.charAt(0).toUpperCase());
        setSafeTextContent(PulseChat.elements.callUserName, PulseChat.selectedFriend.friendUsername);
        updateCallStatus(data.serverRelayed ? 'Calling (Server-Relayed)...' : 'Calling...');
        
        // Show call overlay
        PulseChat.elements.activeCallOverlay.classList.remove('hidden');
        
        // Hide timer initially
        PulseChat.elements.callTimer.classList.add('hidden');
        PulseChat.elements.callTimeRemaining.classList.add('hidden');
        
        updateCallAvailability();
    });
    
    PulseChat.socket.on('call_answered', async (data) => {
        if (!PulseChat.currentCall || PulseChat.currentCall.id !== data.callId) return;
        
        try {
            updateCallStatus('Setting up audio...');
            
            // Setup server-relayed audio instead of WebRTC
            await setupServerRelayedAudio();
            updateCallStatus('Connected (Server-Relayed)');
            
        } catch (error) {
            console.error('Error handling call answer:', error);
            showNotification('Failed to connect call: ' + error.message, 'error');
            endCall();
        }
    });
    
    PulseChat.socket.on('call_connected', async (data) => {
        if (!PulseChat.currentCall || PulseChat.currentCall.id !== data.callId) return;
        
        try {
            // Setup server-relayed audio for incoming call
            await setupServerRelayedAudio();
            
            // Show call overlay if not already shown
            if (PulseChat.elements.activeCallOverlay.classList.contains('hidden')) {
                setSafeTextContent(PulseChat.elements.callAvatar, PulseChat.currentCall.callerUsername.charAt(0).toUpperCase());
                setSafeTextContent(PulseChat.elements.callUserName, PulseChat.currentCall.callerUsername);
                PulseChat.elements.activeCallOverlay.classList.remove('hidden');
            }
            
            updateCallStatus('Connected (Server-Relayed)');
            startCallTimer();
            PulseChat.elements.callTimeRemaining.classList.remove('hidden');
            
            updateCallAvailability();
            
        } catch (error) {
            console.error('Error connecting call:', error);
            showNotification('Failed to connect call: ' + error.message, 'error');
            endCall();
        }
    });
    
    PulseChat.socket.on('call_ended', (data) => {
        const reason = data.reason || 'Call ended';
        
        // Show notification about call end reason
        if (reason === 'timeout') {
            showNotification('Call was not answered', 'info');
        } else if (reason === 'declined') {
            showNotification('Call was declined', 'info');
        } else if (reason === 'time_limit_reached') {
            showNotification('Call ended - time limit reached', 'warning');
        } else if (reason === 'insufficient_time') {
            showNotification('Call ended - insufficient call time', 'warning');
        }
        
        cleanupCall();
        updateCallAvailability();
    });
    
    PulseChat.socket.on('call_error', (message) => {
        showNotification(message, 'error');
        cleanupCall();
        updateCallAvailability();
    });
    
    PulseChat.socket.on('call_time_update', (data) => {
        if (data.remainingTime !== undefined) {
            updateCallTimeDisplay(data.remainingTime);
        }
        
        // Update call time remaining display in active call
        if (PulseChat.elements.callTimeLeft && data.remainingTime !== -1) {
            setSafeTextContent(PulseChat.elements.callTimeLeft, formatCallTime(data.remainingTime));
            PulseChat.elements.callTimeRemaining.classList.remove('hidden');
        }
    });
    
    PulseChat.socket.on('call_time_remaining', (data) => {
        updateCallTimeDisplay(data.remainingTime);
    });
    
    // Server-relayed audio streaming events (REPLACED WebRTC signaling)
    PulseChat.socket.on('audio_stream', (data) => {
        if (!PulseChat.currentCall || PulseChat.currentCall.id !== data.callId) return;
        
        // Process incoming audio from server relay
        if (data.audioData) {
            processIncomingAudio(data.audioData);
        }
    });
    
    PulseChat.socket.on('audio_settings', (data) => {
        if (!PulseChat.currentCall || PulseChat.currentCall.id !== data.callId) return;
        
        // Handle partner audio settings
        if (data.partnerMuted !== undefined) {
            console.log('Partner muted:', data.partnerMuted);
        }
        
        if (data.partnerVolume !== undefined && PulseChat.remoteAudio) {
            PulseChat.remoteAudio.volume = data.partnerVolume;
        }
    });

    // Friends Events
    PulseChat.socket.on('friends_list', (friendsList) => {
        PulseChat.friends = friendsList;
        renderFriendsList();
        renderMobileFriendsList();
        updateCallAvailability();
    });

    PulseChat.socket.on('friend_requests', (requests) => {
        PulseChat.friendRequests = requests;
        renderFriendRequests();
        renderMobileFriendRequests();
    });

    PulseChat.socket.on('blocked_users', (blocked) => {
        PulseChat.blockedUsers = blocked;
        renderBlockedUsers();
    });

    PulseChat.socket.on('friend_request_received', (request) => {
        PulseChat.friendRequests.push(request);
        renderFriendRequests();
        renderMobileFriendRequests();
        const sanitizedUsername = sanitizeInput(request.senderUsername);
        showNotification(`New friend request from ${sanitizedUsername}!`, 'info');
    });

    PulseChat.socket.on('friend_request_accepted', (data) => {
        const sanitizedUsername = sanitizeInput(data.username);
        showNotification(`${sanitizedUsername} accepted your friend request!`, 'success');
    });

    // Message Events
    PulseChat.socket.on('messages_loaded', (data) => {
        if (PulseChat.selectedFriend && data.friendId === PulseChat.selectedFriend.friendId) {
            PulseChat.messages = data.messages;
            renderMessages();
        }
    });

    PulseChat.socket.on('new_message', (message) => {
        if (PulseChat.selectedFriend && 
            (message.senderId === PulseChat.selectedFriend.friendId || message.receiverId === PulseChat.selectedFriend.friendId)) {
            PulseChat.messages.push(message);
            addMessageToChat(message);
        }
        
        // Play notification sound for received messages
        if (message.senderId !== PulseChat.currentUser.id) {
            playNotificationSound();
        }
        
        // Move the friend involved in this message to the top of the list
        moveFriendToTopByMessage(message);
    });

    PulseChat.socket.on('message_sent', (message) => {
        PulseChat.messages.push(message);
        addMessageToChat(message);
        
        // Move the friend we just messaged to the top of the list
        moveFriendToTopByMessage(message);
    });

    PulseChat.socket.on('message_deleted', (data) => {
        // Remove from local messages array first
        PulseChat.messages = PulseChat.messages.filter(m => m.id !== data.messageId);
        
        // Find and remove the message element - use escaped ID for querySelector
        const sanitizedId = escapeHtml(data.messageId);
        const messageElement = document.querySelector(`[data-message-id="${sanitizedId}"]`);
        if (messageElement) {
            messageElement.style.opacity = '0';
            messageElement.style.transform = 'translateY(-20px)';
            setTimeout(() => {
                if (messageElement.parentNode) {
                    messageElement.parentNode.removeChild(messageElement);
                }
                
                // Check if container is now empty and show empty state if needed
                const container = PulseChat.elements.messagesContainer;
                const remainingMessages = container.querySelectorAll('.message');
                if (remainingMessages.length === 0) {
                    container.innerHTML = `
                        <div class="empty-state">
                            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                            </svg>
                            <h3>No messages yet</h3>
                            <p>Start your conversation!</p>
                        </div>
                    `;
                }
            }, 300);
        } else {
            // If element not found, just re-render all messages to ensure consistency
            renderMessages();
        }
    });

    PulseChat.socket.on('message_error', (message) => {
        showNotification(message, 'error');
    });

    // Friend Action Events
    PulseChat.socket.on('friend_request_sent', (request) => {
        showMessage('friendMessage', 'Friend request sent!', 'success');
        setTimeout(() => {
            closeFriendsManagement();
        }, 1500);
    });

    PulseChat.socket.on('friend_request_error', (message) => {
        showMessage('friendMessage', message, 'error');
    });

    PulseChat.socket.on('friend_request_response_sent', (data) => {
        const action = data.accepted ? 'accepted' : 'denied';
        showNotification(`Friend request ${action}!`, 'success');
    });

    PulseChat.socket.on('user_blocked', (data) => {
        showNotification('User blocked successfully!', 'success');
        if (PulseChat.selectedFriend && PulseChat.selectedFriend.friendId === data.userId) {
            PulseChat.selectedFriend = null;
            PulseChat.elements.userInfoPanel.classList.add('hidden');
            PulseChat.elements.mobileUserHeader.classList.add('hidden');
            PulseChat.elements.messagesContainer.innerHTML = `
                <div class="empty-state">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <h3>Select a friend to view your conversation</h3>
                </div>
            `;
            setSafeTextContent(PulseChat.elements.chatTitle, 'Select a friend to start chatting');
            disableInputs();
            updateCallAvailability();
        }
    });

    PulseChat.socket.on('user_unblocked', (data) => {
        showNotification('User unblocked successfully!', 'success');
    });

    PulseChat.socket.on('user_muted', (data) => {
        const sanitizedDuration = sanitizeInput(data.duration || 'indefinite');
        showNotification(`User muted successfully for ${sanitizedDuration}!`, 'success');
    });

    PulseChat.socket.on('user_banned', (data) => {
        showNotification('User banned successfully!', 'success');
        closeBanModal();
    });

    // Settings Events
    PulseChat.socket.on('current_settings', (settings) => {
        // Update UI with current settings from server
        if (PulseChat.elements.allowFriendRequests) {
            PulseChat.elements.allowFriendRequests.checked = settings.allowFriendRequests !== false;
        }
        if (PulseChat.elements.allowNotifications) {
            PulseChat.elements.allowNotifications.checked = settings.allowNotifications !== false;
        }
        if (PulseChat.elements.allowCalls) {
            PulseChat.elements.allowCalls.checked = settings.allowCalls !== false;
        }
        
        // Update call time display
        if (settings.callTimeRemaining !== undefined) {
            updateCallTimeDisplay(settings.callTimeRemaining);
        }
        
        // Update current user settings
        if (PulseChat.currentUser) {
            PulseChat.currentUser.settings = settings;
        }
        
        updateCallAvailability();
    });

    PulseChat.socket.on('settings_updated', (settings) => {
        showMessage('settingsMessage', 'Settings saved successfully!', 'success');
        if (PulseChat.currentUser.settings) {
            PulseChat.currentUser.settings = { ...PulseChat.currentUser.settings, ...settings };
        } else {
            PulseChat.currentUser.settings = settings;
        }
        updateCallAvailability();
        setTimeout(() => {
            closeSettings();
        }, 1500);
    });

    PulseChat.socket.on('settings_error', (message) => {
        showMessage('settingsMessage', message, 'error');
    });

    PulseChat.socket.on('logged_out', () => {
        deleteCookie('pulsechat_session');
        location.reload();
    });
}

// ===== Tier Benefits Configuration (UPDATED) =====
const TIER_BENEFITS = {
    1: [
        { text: 'Basic messaging', available: true },
        { text: 'Friend system', available: true },
        { text: 'Voice calls (5h/week)', available: true },
        { text: 'Image uploads', available: false },
        { text: 'Video uploads', available: false }
    ],
    2: [
        { text: 'Basic messaging', available: true },
        { text: 'Friend system', available: true },
        { text: 'Voice calls (10h/week)', available: true },
        { text: 'Image uploads', available: true },
        { text: 'Video uploads', available: false }
    ],
    3: [
        { text: 'Basic messaging', available: true },
        { text: 'Friend system', available: true },
        { text: 'Voice calls (15h/week)', available: true },
        { text: 'Image uploads', available: true },
        { text: 'Video uploads', available: true }
    ]
};

// ===== Settings Functions =====

function switchSettingsTab(tabName) {
    PulseChat.currentSettingsTab = tabName;
    
    // Update tab buttons
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Update tab content
    document.querySelectorAll('.settings-tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    // Activate selected tab
    const tabButton = Array.from(document.querySelectorAll('.settings-tab-btn')).find(btn => {
        const btnText = btn.textContent.toLowerCase().trim();
        return btnText.includes(tabName.toLowerCase()) || 
               (tabName === 'preferences' && btnText.includes('settings'));
    });
    if (tabButton) {
        tabButton.classList.add('active');
    }
    
    const tabContent = document.getElementById(`${tabName}Tab`);
    if (tabContent) {
        tabContent.classList.add('active');
    }
    
    // Update profile tab content if it's the active tab
    if (tabName === 'profile' && PulseChat.currentUser) {
        updateProfileTab();
    }
}

function updateProfileTab() {
    if (!PulseChat.currentUser) return;
    
    // Update profile information safely
    if (PulseChat.elements.profileUsername) {
        setSafeTextContent(PulseChat.elements.profileUsername, PulseChat.currentUser.username);
    }
    
    if (PulseChat.elements.profileTier) {
        const userRole = PulseChat.currentUser.role || 'user';
        const hasSpecialRole = ['admin', 'owner', 'developer'].includes(userRole);
        const displayTier = hasSpecialRole ? 3 : (PulseChat.currentUser.tier || 1);
        setSafeTextContent(PulseChat.elements.profileTier, `Tier ${displayTier}`);
    }
    
    if (PulseChat.elements.profileRole) {
        const roleElement = PulseChat.elements.profileRole;
        const role = PulseChat.currentUser.role || 'user';
        setSafeTextContent(roleElement, role.toUpperCase());
        roleElement.className = `role-badge ${escapeHtml(role)}`;
    }
    
    // Request current call time
    if (PulseChat.socket) {
        PulseChat.socket.emit('get_call_time');
    }
    
    // Update tier benefits
    updateTierBenefits();
}

function updateTierBenefits() {
    if (!PulseChat.elements.tierBenefitsList || !PulseChat.currentUser) return;
    
    const userTier = PulseChat.currentUser.tier || 1;
    const userRole = PulseChat.currentUser.role || 'user';
    const benefits = TIER_BENEFITS[userTier] || TIER_BENEFITS[1];
    
    // Special role privileges
    const hasSpecialRole = ['admin', 'owner', 'developer'].includes(userRole);
    
    PulseChat.elements.tierBenefitsList.innerHTML = '';
    
    benefits.forEach(benefit => {
        const benefitDiv = document.createElement('div');
        let isAvailable = benefit.available || hasSpecialRole;
        
        benefitDiv.className = `benefit-item ${isAvailable ? 'available' : 'unavailable'}`;
        
        // Use safe HTML template replacement
        setSafeHTML(benefitDiv, `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${isAvailable ? 
                    '<polyline points="20,6 9,17 4,12"></polyline>' : 
                    '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'
                }
            </svg>
            <span>{{BENEFIT_TEXT}}</span>
        `, {
            '{{BENEFIT_TEXT}}': benefit.text
        });
        
        PulseChat.elements.tierBenefitsList.appendChild(benefitDiv);
    });
    
    // Add special role note if applicable
    if (hasSpecialRole) {
        const specialDiv = document.createElement('div');
        specialDiv.className = 'benefit-item available';
        
        setSafeHTML(specialDiv, `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="13,2 3,14 12,14 11,22 21,10 12,10 13,2"></polygon>
            </svg>
            <span>All features unlocked ({{USER_ROLE}} privileges)</span>
        `, {
            '{{USER_ROLE}}': userRole
        });
        
        PulseChat.elements.tierBenefitsList.appendChild(specialDiv);
        
        // Add unlimited calls note for admin/owner
        if (['admin', 'owner'].includes(userRole)) {
            const unlimitedDiv = document.createElement('div');
            unlimitedDiv.className = 'benefit-item available';
            
            setSafeHTML(unlimitedDiv, `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12,6 12,12 16,14"></polyline>
                </svg>
                <span>Unlimited voice calls</span>
            `);
            
            PulseChat.elements.tierBenefitsList.appendChild(unlimitedDiv);
        }
    }
}

// ===== Mobile Navigation Functions =====

function openMobileNav() {
    PulseChat.elements.mobileNavOverlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    
    // Sync mobile data with desktop data
    renderMobileFriendsList();
    renderMobileFriendRequests();
}

function closeMobileNav() {
    PulseChat.elements.mobileNavOverlay.classList.add('hidden');
    document.body.style.overflow = '';
}

function renderMobileFriendsList() {
    const mobileList = PulseChat.elements.mobileFriendsList;
    
    if (PulseChat.friends.length === 0) {
        mobileList.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                    <circle cx="9" cy="7" r="4"></circle>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
                <p>No friends yet</p>
                <p>Add some friends to start chatting!</p>
            </div>
        `;
        return;
    }
    
    mobileList.innerHTML = '';
    
    PulseChat.friends.forEach(friend => {
        const friendDiv = document.createElement('div');
        friendDiv.className = 'friend-item';
        friendDiv.setAttribute('data-friend-id', escapeHtml(friend.friendId));
        
        // Check if this friend is currently selected
        if (PulseChat.selectedFriend && PulseChat.selectedFriend.friendId === friend.friendId) {
            friendDiv.classList.add('active');
        }
        
        // Use safe HTML template replacement
        setSafeHTML(friendDiv, `
            <div class="friend-item-info">
                <div class="friend-username">{{USERNAME}}</div>
                <div class="friend-role">{{ROLE}} • Tier {{TIER}}</div>
            </div>
        `, {
            '{{USERNAME}}': friend.friendUsername,
            '{{ROLE}}': friend.friendRole,
            '{{TIER}}': friend.friendTier
        });
        
        friendDiv.onclick = () => {
            selectFriend(friend);
            closeMobileNav(); // Close mobile nav after selecting a friend
        };
        mobileList.appendChild(friendDiv);
    });
}

function renderMobileFriendRequests() {
    const mobileRequestsList = PulseChat.elements.mobileFriendRequestsList;
    const mobileBadge = PulseChat.elements.mobileFriendRequestsBadge;
    
    if (PulseChat.friendRequests.length === 0) {
        mobileRequestsList.innerHTML = '<div class="empty-state">No pending friend requests</div>';
        mobileBadge.classList.add('hidden');
        return;
    }
    
    // Update badge
    setSafeTextContent(mobileBadge, PulseChat.friendRequests.length);
    mobileBadge.classList.remove('hidden');
    
    mobileRequestsList.innerHTML = '';
    
    PulseChat.friendRequests.forEach(request => {
        const requestDiv = document.createElement('div');
        requestDiv.className = 'friend-request-item';
        
        setSafeHTML(requestDiv, `
            <div class="friend-request-info">
                <span class="friend-request-username">{{USERNAME}}</span>
            </div>
            <div class="friend-request-buttons">
                <button class="friend-request-btn accept-btn" onclick="respondToFriendRequest('{{REQUEST_ID}}', true)">
                    ✓ Accept
                </button>
                <button class="friend-request-btn deny-btn" onclick="respondToFriendRequest('{{REQUEST_ID}}', false)">
                    ✗ Deny
                </button>
            </div>
        `, {
            '{{USERNAME}}': request.senderUsername,
            '{{REQUEST_ID}}': request.id
        });
        
        mobileRequestsList.appendChild(requestDiv);
    });
}

// ===== Mobile User Info Functions =====

function showMobileUserInfo() {
    if (!PulseChat.selectedFriend) return;
    
    updateMobileUserInfo(PulseChat.selectedFriend);
    showModal(PulseChat.elements.mobileUserInfoModal);
}

function closeMobileUserInfo() {
    hideModal(PulseChat.elements.mobileUserInfoModal);
}

function updateMobileUserHeader(friend) {
    if (!friend) {
        PulseChat.elements.mobileUserHeader.classList.add('hidden');
        return;
    }
    
    // Update mobile header elements safely
    setSafeTextContent(PulseChat.elements.mobileHeaderAvatar, friend.friendUsername.charAt(0).toUpperCase());
    setSafeTextContent(PulseChat.elements.mobileHeaderName, friend.friendUsername);
    setSafeTextContent(PulseChat.elements.mobileHeaderStatus, 'Tap to view profile');
    
    // Show mobile header
    PulseChat.elements.mobileUserHeader.classList.remove('hidden');
}

function updateMobileUserInfo(friend) {
    if (!friend) return;
    
    // Update mobile user info modal safely
    setSafeTextContent(PulseChat.elements.mobileUserAvatar, friend.friendUsername.charAt(0).toUpperCase());
    setSafeTextContent(PulseChat.elements.mobileUserName, friend.friendUsername);
    
    const mobileRoleElement = PulseChat.elements.mobileUserRole;
    setSafeTextContent(mobileRoleElement, friend.friendRole);
    mobileRoleElement.className = `role-badge ${escapeHtml(friend.friendRole)}`;
    
    // Update details
    const friendsSinceDate = new Date(friend.friendsSince).toLocaleDateString();
    setSafeTextContent(PulseChat.elements.mobileFriendsSinceDate, friendsSinceDate);
    setSafeTextContent(PulseChat.elements.mobileFriendTier, `Tier ${friend.friendTier}`);
    setSafeTextContent(PulseChat.elements.mobileFriendRoleInfo, friend.friendRole.toUpperCase());
    
    // Show/hide admin actions
    const mobileAdminActions = PulseChat.elements.mobileAdminActions;
    if (isAdminOrOwner()) {
        mobileAdminActions.classList.remove('hidden');
    } else {
        mobileAdminActions.classList.add('hidden');
    }
    
    // Update call button availability
    updateCallAvailability();
}

// ===== Utility Functions =====

// Cookie management
function setCookie(name, value, days) {
    const expires = new Date();
    expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/;SameSite=Strict;Secure`;
}

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
}

function deleteCookie(name) {
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:01 GMT;path=/;SameSite=Strict;Secure`;
}

// Show notification with safe content
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    
    setSafeHTML(notification, `
        <div style="font-weight: 500; margin-bottom: 4px;">{{MESSAGE}}</div>
    `, {
        '{{MESSAGE}}': message
    });
    
    PulseChat.elements.notificationContainer.appendChild(notification);
    
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }
    }, 5000);
}

// Check if current user is admin or owner
function isAdminOrOwner() {
    return PulseChat.currentUser && ['admin', 'owner'].includes(PulseChat.currentUser.role);
}

// Show/hide modals
function showModal(modalElement) {
    modalElement.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function hideModal(modalElement) {
    modalElement.classList.add('hidden');
    document.body.style.overflow = '';
}

// Message display functions
function showMessage(elementId, message, type) {
    const element = document.getElementById(elementId);
    if (element) {
        element.className = `message-display ${type}-message`;
        setSafeTextContent(element, message);
    }
}

function clearMessage(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
        element.innerHTML = '';
    }
}

// ===== Authentication Functions =====

function login() {
    const username = sanitizeInput(PulseChat.elements.username.value, 50);
    const password = sanitizeInput(PulseChat.elements.password.value, 200);
    
    if (!username || !password) {
        showMessage('authMessage', 'Please enter username and password', 'error');
        return;
    }
    
    PulseChat.socket.emit('authenticate', { username, password });
}

function register() {
    const username = sanitizeInput(PulseChat.elements.regUsername.value, 50);
    const password = sanitizeInput(PulseChat.elements.regPassword.value, 200);
    
    if (!username || !password) {
        showMessage('regMessage', 'Please enter username and password', 'error');
        return;
    }
    
    fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            showMessage('regMessage', data.error, 'error');
        } else {
            showMessage('regMessage', 'Registration successful! You can now login.', 'success');
            setTimeout(() => {
                showLogin();
            }, 1500);
        }
    })
    .catch(err => {
        showMessage('regMessage', 'Registration failed', 'error');
    });
}

function logout() {
    // End any active calls before logging out
    if (PulseChat.currentCall) {
        endCall();
    }
    
    PulseChat.socket.emit('logout');
}

function showLogin() {
    showModal(PulseChat.elements.loginModal);
    hideModal(PulseChat.elements.registerModal);
    clearMessage('authMessage');
    clearMessage('regMessage');
}

function showRegister() {
    hideModal(PulseChat.elements.loginModal);
    showModal(PulseChat.elements.registerModal);
    clearMessage('authMessage');
    clearMessage('regMessage');
}

function checkAutoLogin() {
    const sessionToken = getCookie('pulsechat_session');
    if (sessionToken) {
        showModal(PulseChat.elements.autoLoginIndicator);
        PulseChat.socket.emit('authenticate', { sessionToken });
    }
}

// ===== Friends Management =====

function showFriendsManagement() {
    showModal(PulseChat.elements.friendsManagementModal);
    renderBlockedUsers();
    // Close mobile nav if it's open
    if (!PulseChat.elements.mobileNavOverlay.classList.contains('hidden')) {
        closeMobileNav();
    }
}

function closeFriendsManagement() {
    hideModal(PulseChat.elements.friendsManagementModal);
    PulseChat.elements.friendUsername.value = '';
    clearMessage('friendMessage');
}

function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    if (tabName === 'addFriend') {
        document.querySelector('.tab-btn').classList.add('active');
        document.getElementById('addFriendTab').classList.add('active');
    } else if (tabName === 'unblockUsers') {
        document.querySelectorAll('.tab-btn')[1].classList.add('active');
        document.getElementById('unblockUsersTab').classList.add('active');
        renderBlockedUsers();
    }
}

function sendFriendRequest() {
    const username = sanitizeInput(PulseChat.elements.friendUsername.value, 50);
    
    if (!username) {
        showMessage('friendMessage', 'Please enter a username', 'error');
        return;
    }
    
    PulseChat.socket.emit('send_friend_request', { username });
}

function toggleFriendRequests() {
    PulseChat.friendRequestsVisible = !PulseChat.friendRequestsVisible;
    const requestsList = PulseChat.elements.friendRequestsList;
    const toggle = PulseChat.elements.friendRequestsToggle;
    const mobileRequestsList = PulseChat.elements.mobileFriendRequestsList;
    const mobileToggle = PulseChat.elements.mobileFriendRequestsToggle;
    
    if (PulseChat.friendRequestsVisible) {
        requestsList.classList.remove('collapsed');
        mobileRequestsList.classList.remove('collapsed');
        toggle.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6,9 12,15 18,9"></polyline>
            </svg>
        `;
        mobileToggle.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6,9 12,15 18,9"></polyline>
            </svg>
        `;
    } else {
        requestsList.classList.add('collapsed');
        mobileRequestsList.classList.add('collapsed');
        toggle.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9,18 15,12 9,6"></polyline>
            </svg>
        `;
        mobileToggle.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9,18 15,12 9,6"></polyline>
            </svg>
        `;
    }
}

function renderFriendRequests() {
    const requestsList = PulseChat.elements.friendRequestsList;
    const badge = PulseChat.elements.friendRequestsBadge;
    
    if (PulseChat.friendRequests.length === 0) {
        requestsList.innerHTML = '<div class="empty-state">No pending friend requests</div>';
        badge.classList.add('hidden');
        return;
    }
    
    // Update badge
    setSafeTextContent(badge, PulseChat.friendRequests.length);
    badge.classList.remove('hidden');
    
    requestsList.innerHTML = '';
    
    PulseChat.friendRequests.forEach(request => {
        const requestDiv = document.createElement('div');
        requestDiv.className = 'friend-request-item';
        
        setSafeHTML(requestDiv, `
            <div class="friend-request-info">
                <span class="friend-request-username">{{USERNAME}}</span>
            </div>
            <div class="friend-request-buttons">
                <button class="friend-request-btn accept-btn" onclick="respondToFriendRequest('{{REQUEST_ID}}', true)">
                    ✓ Accept
                </button>
                <button class="friend-request-btn deny-btn" onclick="respondToFriendRequest('{{REQUEST_ID}}', false)">
                    ✗ Deny
                </button>
            </div>
        `, {
            '{{USERNAME}}': request.senderUsername,
            '{{REQUEST_ID}}': request.id
        });
        
        requestsList.appendChild(requestDiv);
    });
}

function renderBlockedUsers() {
    const blockedList = PulseChat.elements.blockedUsersList;
    
    if (PulseChat.blockedUsers.length === 0) {
        blockedList.innerHTML = '<div class="empty-state">No blocked users</div>';
        return;
    }
    
    blockedList.innerHTML = '';
    
    PulseChat.blockedUsers.forEach(blocked => {
        const blockedDiv = document.createElement('div');
        blockedDiv.className = 'blocked-user-item';
        
        setSafeHTML(blockedDiv, `
            <span class="blocked-username">{{USERNAME}}</span>
            <button class="unblock-btn" onclick="unblockUser('{{USER_ID}}')">
                Unblock
            </button>
        `, {
            '{{USERNAME}}': blocked.blockedUsername,
            '{{USER_ID}}': blocked.blockedId
        });
        
        blockedList.appendChild(blockedDiv);
    });
}

function renderFriendsList() {
    const friendsList = PulseChat.elements.friendsList;
    
    if (PulseChat.friends.length === 0) {
        friendsList.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                    <circle cx="9" cy="7" r="4"></circle>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
                <p>No friends yet</p>
                <p>Add some friends to start chatting!</p>
            </div>
        `;
        return;
    }
    
    friendsList.innerHTML = '';
    
    PulseChat.friends.forEach(friend => {
        const friendDiv = document.createElement('div');
        friendDiv.className = 'friend-item';
        friendDiv.setAttribute('data-friend-id', escapeHtml(friend.friendId));
        
        // Check if this friend is currently selected
        if (PulseChat.selectedFriend && PulseChat.selectedFriend.friendId === friend.friendId) {
            friendDiv.classList.add('active');
        }
        
        setSafeHTML(friendDiv, `
            <div class="friend-item-info">
                <div class="friend-username">{{USERNAME}}</div>
                <div class="friend-role">{{ROLE}} • Tier {{TIER}}</div>
            </div>
        `, {
            '{{USERNAME}}': friend.friendUsername,
            '{{ROLE}}': friend.friendRole,
            '{{TIER}}': friend.friendTier
        });
        
        friendDiv.onclick = () => selectFriend(friend);
        friendsList.appendChild(friendDiv);
    });
}

function respondToFriendRequest(requestId, accept) {
    const sanitizedRequestId = sanitizeInput(requestId, 100);
    PulseChat.socket.emit('respond_friend_request', { requestId: sanitizedRequestId, accept });
}

function unblockUser(userId) {
    const sanitizedUserId = sanitizeInput(userId, 100);
    PulseChat.socket.emit('unblock_user', { userId: sanitizedUserId });
    
    // Optimistically remove from local state for immediate UI update
    PulseChat.blockedUsers = PulseChat.blockedUsers.filter(blocked => blocked.blockedId !== userId);
    renderBlockedUsers();
}

// ===== Chat Functions =====

function selectFriend(friend) {
    PulseChat.selectedFriend = friend;
    
    // Update UI for both desktop and mobile
    document.querySelectorAll('.friend-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Update both desktop and mobile friend items
    const escapedFriendId = escapeHtml(friend.friendId);
    const desktopFriendElement = PulseChat.elements.friendsList.querySelector(`[data-friend-id="${escapedFriendId}"]`);
    const mobileFriendElement = PulseChat.elements.mobileFriendsList.querySelector(`[data-friend-id="${escapedFriendId}"]`);
    
    if (desktopFriendElement) {
        desktopFriendElement.classList.add('active');
    }
    if (mobileFriendElement) {
        mobileFriendElement.classList.add('active');
    }
    
    // Update desktop title
    setSafeTextContent(PulseChat.elements.chatTitle, `Chat with ${friend.friendUsername}`);
    
    // Update mobile header
    updateMobileUserHeader(friend);
    
    // Enable inputs
    PulseChat.elements.messageInput.disabled = false;
    PulseChat.elements.sendBtn.disabled = false;
    PulseChat.elements.uploadBtn.disabled = false;
    
    // Update user info panels (both desktop and mobile)
    updateUserInfoPanel(friend);
    updateMobileUserInfo(friend);
    PulseChat.elements.userInfoPanel.classList.remove('hidden');
    
    // Update call button availability
    updateCallAvailability();
    
    // Load messages
    PulseChat.socket.emit('load_messages', { friendId: friend.friendId });
    
    // Show loading indicator
    PulseChat.elements.messagesContainer.innerHTML = `
        <div class="loading-indicator">
            <div class="loading-spinner"></div>
            <p>Loading messages...</p>
        </div>
    `;
}

function updateUserInfoPanel(friend) {
    // Update desktop avatar (first letter of username) safely
    const avatar = PulseChat.elements.friendAvatar;
    setSafeTextContent(avatar, friend.friendUsername.charAt(0).toUpperCase());
    
    // Update desktop info
    setSafeTextContent(PulseChat.elements.friendInfoUsername, friend.friendUsername);
    
    const roleElement = PulseChat.elements.friendInfoRole;
    setSafeTextContent(roleElement, friend.friendRole);
    roleElement.className = `role-badge ${escapeHtml(friend.friendRole)}`;
    
    // Update desktop details
    const friendsSinceDate = new Date(friend.friendsSince).toLocaleDateString();
    setSafeTextContent(PulseChat.elements.friendsSinceDate, friendsSinceDate);
    setSafeTextContent(PulseChat.elements.friendTier, `Tier ${friend.friendTier}`);
    setSafeTextContent(PulseChat.elements.friendRoleInfo, friend.friendRole.toUpperCase());
    
    // Show/hide admin actions for desktop
    const adminActions = PulseChat.elements.adminActions;
    if (isAdminOrOwner()) {
        adminActions.classList.remove('hidden');
    } else {
        adminActions.classList.add('hidden');
    }
}

function sendMessage() {
    if (!PulseChat.selectedFriend) return;
    
    const input = PulseChat.elements.messageInput;
    const content = sanitizeMessage(input.value);
    
    if (!content) {
        input.value = '';
        return;
    }
    
    PulseChat.socket.emit('send_message', {
        receiverId: PulseChat.selectedFriend.friendId,
        content: content
    });
    
    input.value = '';
    input.style.height = 'auto';
}

function renderMessages() {
    const container = PulseChat.elements.messagesContainer;
    container.innerHTML = '';
    
    if (PulseChat.messages.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <h3>No messages yet</h3>
                <p>Start your conversation!</p>
            </div>
        `;
        return;
    }
    
    PulseChat.messages.forEach(message => {
        addMessageToChat(message, false);
    });
    
    container.scrollTop = container.scrollHeight;
}

function addMessageToChat(message, scroll = true) {
    const container = PulseChat.elements.messagesContainer;
    
    // Remove placeholder message if it exists
    const placeholder = container.querySelector('.empty-state, .loading-indicator');
    if (placeholder) {
        placeholder.remove();
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${message.senderId === PulseChat.currentUser.id ? 'own' : ''}`;
    messageDiv.setAttribute('data-message-id', escapeHtml(message.id));
    
    const timestamp = new Date(message.timestamp).toLocaleTimeString();
    const senderName = message.senderId === PulseChat.currentUser.id ? 'You' : PulseChat.selectedFriend.friendUsername;
    
    // Check if user can delete this message
    const canDelete = message.senderId === PulseChat.currentUser.id || isAdminOrOwner();
    
    const actionsHtml = canDelete ? `
        <div class="message-actions">
            <button class="message-action-btn delete-btn" onclick="deleteMessage('{{MESSAGE_ID}}')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3,6 5,6 21,6"></polyline>
                    <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6"></path>
                </svg>
            </button>
        </div>
    ` : '';
    
    if (message.type === 'text') {
        setSafeHTML(messageDiv, `
            <div class="message-header">{{SENDER_NAME}} • {{TIMESTAMP}}</div>
            <div class="message-content">{{CONTENT}}</div>
            ${actionsHtml}
        `, {
            '{{SENDER_NAME}}': senderName,
            '{{TIMESTAMP}}': timestamp,
            '{{CONTENT}}': message.content,
            '{{MESSAGE_ID}}': message.id
        });
    } else if (message.type === 'image') {
        // Validate media URL for security
        const mediaUrl = `/api/media/${message.content}`;
        if (!isValidMediaUrl(mediaUrl)) {
            console.error('Invalid media URL detected');
            return;
        }
        
        setSafeHTML(messageDiv, `
            <div class="message-header">{{SENDER_NAME}} • {{TIMESTAMP}}</div>
            <div class="message-content">
                <img src="{{MEDIA_URL}}" alt="Shared image" loading="lazy">
            </div>
            ${actionsHtml}
        `, {
            '{{SENDER_NAME}}': senderName,
            '{{TIMESTAMP}}': timestamp,
            '{{MEDIA_URL}}': mediaUrl,
            '{{MESSAGE_ID}}': message.id
        });
    } else if (message.type === 'video') {
        // Validate media URL for security
        const mediaUrl = `/api/media/${message.content}`;
        if (!isValidMediaUrl(mediaUrl)) {
            console.error('Invalid media URL detected');
            return;
        }
        
        setSafeHTML(messageDiv, `
            <div class="message-header">{{SENDER_NAME}} • {{TIMESTAMP}}</div>
            <div class="message-content">
                <video controls preload="metadata">
                    <source src="{{MEDIA_URL}}" type="video/mp4">
                    <source src="{{MEDIA_URL}}" type="video/webm">
                    Your browser does not support the video tag.
                </video>
            </div>
            ${actionsHtml}
        `, {
            '{{SENDER_NAME}}': senderName,
            '{{TIMESTAMP}}': timestamp,
            '{{MEDIA_URL}}': mediaUrl,
            '{{MESSAGE_ID}}': message.id
        });
    }
    
    container.appendChild(messageDiv);
    
    if (scroll) {
        container.scrollTop = container.scrollHeight;
    }
}

function deleteMessage(messageId) {
    if (!confirm('Are you sure you want to delete this message?')) {
        return;
    }
    
    const sanitizedMessageId = sanitizeInput(messageId, 100);
    PulseChat.socket.emit('delete_message', { messageId: sanitizedMessageId });
}

function uploadFile() {
    if (!PulseChat.selectedFriend) return;
    
    const fileInput = PulseChat.elements.fileInput;
    const file = fileInput.files[0];
    
    if (!file) return;
    
    // Check file type based on user tier
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    
    if (!isImage && !isVideo) {
        showNotification('Please select an image or video file', 'error');
        fileInput.value = '';
        return;
    }
    
    // Additional file validation for security
    const maxFileSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxFileSize) {
        showNotification('File is too large. Maximum size is 50MB.', 'error');
        fileInput.value = '';
        return;
    }
    
    const userTier = PulseChat.currentUser.tier || 1;
    const userRole = PulseChat.currentUser.role || 'user';
    const hasSpecialRole = ['admin', 'owner', 'developer'].includes(userRole);
    
    if (isVideo && userTier < 3 && !hasSpecialRole) {
        showNotification('You need Tier 3 to upload videos', 'error');
        fileInput.value = '';
        return;
    }
    
    if (isImage && userTier < 2 && !hasSpecialRole) {
        showNotification('You need Tier 2 to upload images', 'error');
        fileInput.value = '';
        return;
    }
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('userId', PulseChat.currentUser.id);
    formData.append('receiverId', PulseChat.selectedFriend.friendId);
    
    fetch('/api/upload', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) {
            showNotification(data.error, 'error');
        } else {
            showNotification('File uploaded successfully!', 'success');
        }
        // Always clear the input after upload attempt
        fileInput.value = '';
    })
    .catch(err => {
            showNotification('Upload failed', 'error');
            fileInput.value = '';
        });
    }

function disableInputs() {
    PulseChat.elements.messageInput.disabled = true;
    PulseChat.elements.sendBtn.disabled = true;
    PulseChat.elements.uploadBtn.disabled = true;
}

// ===== User Actions =====

function blockUser() {
    if (!PulseChat.selectedFriend) return;
    
    if (confirm(`Are you sure you want to block ${PulseChat.selectedFriend.friendUsername}? This will delete all chat history between you.`)) {
        PulseChat.socket.emit('block_user', { userId: PulseChat.selectedFriend.friendId });
    }
}

function muteUser() {
    if (!PulseChat.selectedFriend || !isAdminOrOwner()) return;
    
    // Get duration from both desktop and mobile selects
    const desktopDuration = PulseChat.elements.muteDuration.value;
    const mobileDuration = PulseChat.elements.mobileMuteDuration.value;
    const duration = desktopDuration || mobileDuration;
    const reason = `Muted by ${PulseChat.currentUser.role} for ${duration}`;
    
    if (confirm(`Are you sure you want to mute ${PulseChat.selectedFriend.friendUsername} for ${duration}?`)) {
        PulseChat.socket.emit('admin_mute_user', { 
            userId: PulseChat.selectedFriend.friendId, 
            duration, 
            reason 
        });
    }
}

function showBanModal() {
    if (!PulseChat.selectedFriend) return;
    PulseChat.userToBan = PulseChat.selectedFriend.friendId;
    showModal(PulseChat.elements.banReasonModal);
    // Close mobile user info modal if open
    if (!PulseChat.elements.mobileUserInfoModal.classList.contains('hidden')) {
        closeMobileUserInfo();
    }
}

function closeBanModal() {
    hideModal(PulseChat.elements.banReasonModal);
    PulseChat.elements.banReason.value = '';
    PulseChat.userToBan = null;
}

function confirmBan() {
    if (!PulseChat.userToBan) return;
    
    const reason = sanitizeInput(PulseChat.elements.banReason.value, 500);
    PulseChat.socket.emit('admin_ban_user', { userId: PulseChat.userToBan, reason });
}

// ===== Settings =====

function showSettings() {
    showModal(PulseChat.elements.settingsModal);
    
    // Request current settings from server
    PulseChat.socket.emit('get_current_settings');
    
    // Default to profile tab
    switchSettingsTab('profile');
    
    // Close mobile nav if it's open
    if (!PulseChat.elements.mobileNavOverlay.classList.contains('hidden')) {
        closeMobileNav();
    }
}

function closeSettings() {
    hideModal(PulseChat.elements.settingsModal);
    clearMessage('settingsMessage');
}

function saveSettings() {
    const allowFriendRequests = PulseChat.elements.allowFriendRequests.checked;
    const allowNotifications = PulseChat.elements.allowNotifications.checked;
    const allowCalls = PulseChat.elements.allowCalls.checked;
    
    PulseChat.socket.emit('update_settings', { 
        allowFriendRequests,
        allowNotifications,
        allowCalls
    });
}

// ===== Event Listeners =====

// Call button event listeners
if (PulseChat.elements.muteBtn) {
    PulseChat.elements.muteBtn.addEventListener('click', toggleMute);
}

if (PulseChat.elements.speakerBtn) {
    PulseChat.elements.speakerBtn.addEventListener('click', toggleSpeaker);
}

// Mobile Navigation Event Listeners
PulseChat.elements.mobileMenuBtn.addEventListener('click', openMobileNav);
PulseChat.elements.mobileNavClose.addEventListener('click', closeMobileNav);

// Mobile navigation backdrop click
document.addEventListener('click', function(e) {
    if (e.target.classList.contains('mobile-nav-backdrop')) {
        closeMobileNav();
    }
});

// Auto-resize textarea
PulseChat.elements.messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// Send message on Enter (without Shift)
PulseChat.elements.messageInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Form submissions
PulseChat.elements.username.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        login();
    }
});

PulseChat.elements.password.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        login();
    }
});

PulseChat.elements.regUsername.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        register();
    }
});

PulseChat.elements.regPassword.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        register();
    }
});

PulseChat.elements.friendUsername.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendFriendRequest();
    }
});

// Modal backdrop clicks
document.addEventListener('click', function(e) {
    if (e.target.classList.contains('modal-backdrop')) {
        // Close the modal
        const modal = e.target.parentElement;
        if (modal.id === 'loginModal' || modal.id === 'registerModal') {
            // Don't close auth modals by clicking backdrop
            return;
        }
        
        // Don't close call modals by clicking backdrop
        if (modal.id === 'incomingCallModal') {
            return;
        }
        
        hideModal(modal);
        
        // Clear specific modal data
        if (modal.id === 'friendsManagementModal') {
            closeFriendsManagement();
        } else if (modal.id === 'settingsModal') {
            closeSettings();
        } else if (modal.id === 'banReasonModal') {
            closeBanModal();
        } else if (modal.id === 'mobileUserInfoModal') {
            closeMobileUserInfo();
        }
    }
});

// Handle window resize to manage mobile/desktop views
window.addEventListener('resize', function() {
    // Close mobile nav if window becomes desktop size
    if (window.innerWidth > 768 && !PulseChat.elements.mobileNavOverlay.classList.contains('hidden')) {
        closeMobileNav();
    }
});

// Handle page visibility changes for call management
document.addEventListener('visibilitychange', function() {
    if (document.hidden && PulseChat.currentCall) {
        // User switched away from tab during call
        console.log('User switched away during call');
    }
});

// Handle beforeunload for active calls
window.addEventListener('beforeunload', function(e) {
    if (PulseChat.currentCall) {
        // End the call before page unload
        endCall();
        
        // Show warning to user
        e.preventDefault();
        e.returnValue = 'You have an active call. Are you sure you want to leave?';
        return e.returnValue;
    }
});

// ===== Initialization =====

window.addEventListener('load', () => {
    // Create notification sound
    createNotificationSound();
    
    // Initialize socket, visibility handling, and message input focus detection
    initializeSocket();
    setupVisibilityHandling();
    setupMessageInputFocusDetection();
    
    // Try auto-login
    checkAutoLogin();
    
    // Initialize call button states
    updateCallButtonStates();
});

// Make functions available globally for HTML onclick handlers
window.login = login;
window.register = register;
window.logout = logout;
window.showLogin = showLogin;
window.showRegister = showRegister;
window.showFriendsManagement = showFriendsManagement;
window.closeFriendsManagement = closeFriendsManagement;
window.switchTab = switchTab;
window.sendFriendRequest = sendFriendRequest;
window.toggleFriendRequests = toggleFriendRequests;
window.respondToFriendRequest = respondToFriendRequest;
window.unblockUser = unblockUser;
window.sendMessage = sendMessage;
window.deleteMessage = deleteMessage;
window.uploadFile = uploadFile;
window.blockUser = blockUser;
window.muteUser = muteUser;
window.showBanModal = showBanModal;
window.closeBanModal = closeBanModal;
window.confirmBan = confirmBan;
window.showSettings = showSettings;
window.closeSettings = closeSettings;
window.saveSettings = saveSettings;
window.showMobileUserInfo = showMobileUserInfo;
window.closeMobileUserInfo = closeMobileUserInfo;
window.switchSettingsTab = switchSettingsTab;

// Voice calling functions
window.initiateCall = initiateCall;
window.answerCall = answerCall;
window.endCall = endCall;
window.toggleMute = toggleMute;
window.toggleSpeaker = toggleSpeaker;