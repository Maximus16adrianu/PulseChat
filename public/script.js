// ===== PulseChat Application =====

// Global State
const PulseChat = {
    socket: io(),
    currentUser: null,
    selectedFriend: null,
    friends: [],
    friendRequests: [],
    blockedUsers: [],
    messages: [],
    friendRequestsVisible: true,
    userToBan: null,
    currentSettingsTab: 'profile',
    
    // WebRTC Call State
    currentCall: null,
    localStream: null,
    remoteStream: null,
    peerConnection: null,
    callTimer: null,
    callStartTime: null,
    isMuted: false,
    
    // UI Elements Cache
    elements: {
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
        mobileCallBtn: document.getElementById('mobileCallBtn'),
        mobileAdminActions: document.getElementById('mobileAdminActions'),
        mobileMuteDuration: document.getElementById('mobileMuteDuration'),
        
        // Call Modals
        incomingCallModal: document.getElementById('incomingCallModal'),
        activeCallModal: document.getElementById('activeCallModal'),
        incomingCallAvatar: document.getElementById('incomingCallAvatar'),
        incomingCallUsername: document.getElementById('incomingCallUsername'),
        activeCallAvatar: document.getElementById('activeCallAvatar'),
        activeCallUsername: document.getElementById('activeCallUsername'),
        callStatus: document.getElementById('callStatus'),
        callTimer: document.getElementById('callTimer'),
        muteBtn: document.getElementById('muteBtn'),
        muteText: document.getElementById('muteText'),
        localAudio: document.getElementById('localAudio'),
        remoteAudio: document.getElementById('remoteAudio'),
        
        // Modals
        loginModal: document.getElementById('loginModal'),
        registerModal: document.getElementById('registerModal'),
        friendsManagementModal: document.getElementById('friendsManagementModal'),
        settingsModal: document.getElementById('settingsModal'),
        banReasonModal: document.getElementById('banReasonModal'),
        autoLoginIndicator: document.getElementById('autoLoginIndicator'),
        
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
        callBtn: document.getElementById('callBtn'),
        
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
        banReason: document.getElementById('banReason'),
        muteDuration: document.getElementById('muteDuration'),
        
        // Settings Profile Elements
        profileUsername: document.getElementById('profileUsername'),
        profileTier: document.getElementById('profileTier'),
        profileRole: document.getElementById('profileRole'),
        tierBenefitsList: document.getElementById('tierBenefitsList'),
        
        // Settings Tab Elements
        profileTab: document.getElementById('profileTab'),
        privacyTab: document.getElementById('privacyTab'),
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

// ===== WebRTC Configuration =====
const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// ===== Tier Benefits Configuration =====
const TIER_BENEFITS = {
    1: [
        { text: 'Basic messaging', available: true },
        { text: 'Friend system', available: true },
        { text: 'Voice calls', available: true },
        { text: 'Image uploads', available: false },
        { text: 'Video uploads', available: false }
    ],
    2: [
        { text: 'Basic messaging', available: true },
        { text: 'Friend system', available: true },
        { text: 'Voice calls', available: true },
        { text: 'Image uploads', available: true },
        { text: 'Video uploads', available: false }
    ],
    3: [
        { text: 'Basic messaging', available: true },
        { text: 'Friend system', available: true },
        { text: 'Voice calls', available: true },
        { text: 'Image uploads', available: true },
        { text: 'Video uploads', available: true }
    ]
};

// ===== WebRTC Functions =====

async function initializeWebRTC() {
    try {
        PulseChat.peerConnection = new RTCPeerConnection(RTC_CONFIG);
        
        // Handle incoming streams
        PulseChat.peerConnection.ontrack = (event) => {
            console.log('Received remote stream');
            PulseChat.remoteStream = event.streams[0];
            PulseChat.elements.remoteAudio.srcObject = PulseChat.remoteStream;
        };
        
        // Handle ICE candidates
        PulseChat.peerConnection.onicecandidate = (event) => {
            if (event.candidate && PulseChat.currentCall) {
                PulseChat.socket.emit('webrtc_ice_candidate', {
                    callId: PulseChat.currentCall.callId,
                    candidate: event.candidate
                });
            }
        };
        
        // Handle connection state changes
        PulseChat.peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', PulseChat.peerConnection.connectionState);
            updateCallStatus(PulseChat.peerConnection.connectionState);
        };
        
        return true;
    } catch (error) {
        console.error('Failed to initialize WebRTC:', error);
        return false;
    }
}

async function getUserMedia() {
    try {
        PulseChat.localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: true, 
            video: false 
        });
        
        PulseChat.elements.localAudio.srcObject = PulseChat.localStream;
        
        // Add tracks to peer connection
        if (PulseChat.peerConnection) {
            PulseChat.localStream.getTracks().forEach(track => {
                PulseChat.peerConnection.addTrack(track, PulseChat.localStream);
            });
        }
        
        return true;
    } catch (error) {
        console.error('Failed to get user media:', error);
        showNotification('Could not access microphone. Please check permissions.', 'error');
        return false;
    }
}

function cleanupWebRTC() {
    // Stop local stream
    if (PulseChat.localStream) {
        PulseChat.localStream.getTracks().forEach(track => track.stop());
        PulseChat.localStream = null;
    }
    
    // Stop remote stream
    if (PulseChat.remoteStream) {
        PulseChat.remoteStream.getTracks().forEach(track => track.stop());
        PulseChat.remoteStream = null;
    }
    
    // Close peer connection
    if (PulseChat.peerConnection) {
        PulseChat.peerConnection.close();
        PulseChat.peerConnection = null;
    }
    
    // Clear audio elements
    PulseChat.elements.localAudio.srcObject = null;
    PulseChat.elements.remoteAudio.srcObject = null;
    
    // Reset mute state
    PulseChat.isMuted = false;
    updateMuteButton();
}

function updateCallStatus(status) {
    const statusElement = PulseChat.elements.callStatus;
    const statusText = status === 'connected' ? 'Connected' : 
                     status === 'connecting' ? 'Connecting...' : 
                     status === 'disconnected' ? 'Disconnected' : 'Connecting...';
    
    statusElement.textContent = statusText;
    statusElement.className = `${status}`;
    
    if (status === 'connected' && !PulseChat.callTimer) {
        startCallTimer();
    }
}

function startCallTimer() {
    PulseChat.callStartTime = Date.now();
    PulseChat.callTimer = setInterval(() => {
        const elapsed = Date.now() - PulseChat.callStartTime;
        const minutes = Math.floor(elapsed / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        PulseChat.elements.callTimer.textContent = 
            `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
}

function stopCallTimer() {
    if (PulseChat.callTimer) {
        clearInterval(PulseChat.callTimer);
        PulseChat.callTimer = null;
    }
    PulseChat.elements.callTimer.textContent = '00:00';
}

function updateMuteButton() {
    const muteBtn = PulseChat.elements.muteBtn;
    const muteText = PulseChat.elements.muteText;
    
    if (PulseChat.isMuted) {
        muteBtn.classList.add('muted');
        muteText.textContent = 'Unmute';
        muteBtn.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <line x1="23" y1="9" x2="17" y2="15"></line>
                <line x1="17" y1="9" x2="23" y2="15"></line>
            </svg>
            <span id="muteText">Unmute</span>
        `;
    } else {
        muteBtn.classList.remove('muted');
        muteText.textContent = 'Mute';
        muteBtn.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            </svg>
            <span id="muteText">Mute</span>
        `;
    }
}

// ===== Call Functions =====

async function initiateCall() {
    if (!PulseChat.selectedFriend) {
        showNotification('No friend selected', 'error');
        return;
    }
    
    if (PulseChat.currentCall) {
        showNotification('Already in a call', 'error');
        return;
    }
    
    try {
        // Initialize WebRTC
        if (!await initializeWebRTC()) {
            showNotification('Failed to initialize call system', 'error');
            return;
        }
        
        // Get user media
        if (!await getUserMedia()) {
            return;
        }
        
        // Send call initiation to server
        PulseChat.socket.emit('initiate_call', {
            receiverId: PulseChat.selectedFriend.friendId
        });
        
    } catch (error) {
        console.error('Failed to initiate call:', error);
        showNotification('Failed to start call', 'error');
        cleanupWebRTC();
    }
}

async function acceptCall() {
    if (!PulseChat.currentCall) return;
    
    try {
        // Initialize WebRTC if not already done
        if (!PulseChat.peerConnection && !await initializeWebRTC()) {
            showNotification('Failed to initialize call system', 'error');
            return;
        }
        
        // Get user media
        if (!await getUserMedia()) {
            return;
        }
        
        // Accept the call
        PulseChat.socket.emit('accept_call', {
            callId: PulseChat.currentCall.callId
        });
        
        // Hide incoming call modal and show active call modal
        hideModal(PulseChat.elements.incomingCallModal);
        showActiveCallModal(PulseChat.currentCall.callerUsername, PulseChat.currentCall.callerId);
        
    } catch (error) {
        console.error('Failed to accept call:', error);
        showNotification('Failed to accept call', 'error');
        declineCall();
    }
}

function declineCall() {
    if (!PulseChat.currentCall) return;
    
    PulseChat.socket.emit('decline_call', {
        callId: PulseChat.currentCall.callId
    });
    
    hideModal(PulseChat.elements.incomingCallModal);
    endCurrentCall();
}

function hangUpCall() {
    if (!PulseChat.currentCall) return;
    
    PulseChat.socket.emit('hang_up_call', {
        callId: PulseChat.currentCall.callId
    });
    
    endCurrentCall();
}

function toggleMute() {
    if (!PulseChat.localStream) return;
    
    PulseChat.isMuted = !PulseChat.isMuted;
    
    PulseChat.localStream.getAudioTracks().forEach(track => {
        track.enabled = !PulseChat.isMuted;
    });
    
    updateMuteButton();
}

function endCurrentCall() {
    // Hide call modals
    hideModal(PulseChat.elements.incomingCallModal);
    hideModal(PulseChat.elements.activeCallModal);
    
    // Stop call timer
    stopCallTimer();
    
    // Cleanup WebRTC
    cleanupWebRTC();
    
    // Clear call state
    PulseChat.currentCall = null;
}

function showIncomingCallModal(callerUsername, callerId) {
    // Set caller info
    PulseChat.elements.incomingCallAvatar.textContent = callerUsername.charAt(0).toUpperCase();
    PulseChat.elements.incomingCallUsername.textContent = callerUsername;
    
    // Add ringing animation to avatar
    PulseChat.elements.incomingCallAvatar.classList.add('ringing');
    
    // Show modal
    showModal(PulseChat.elements.incomingCallModal);
}

function showActiveCallModal(username, userId) {
    // Set user info
    PulseChat.elements.activeCallAvatar.textContent = username.charAt(0).toUpperCase();
    PulseChat.elements.activeCallUsername.textContent = username;
    
    // Reset call status
    updateCallStatus('connecting');
    updateMuteButton();
    
    // Show modal
    showModal(PulseChat.elements.activeCallModal);
}

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
    const tabButton = Array.from(document.querySelectorAll('.settings-tab-btn')).find(btn => 
        btn.textContent.toLowerCase().includes(tabName.toLowerCase())
    );
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
    
    // Update profile information
    if (PulseChat.elements.profileUsername) {
        PulseChat.elements.profileUsername.textContent = PulseChat.currentUser.username;
    }
    
    if (PulseChat.elements.profileTier) {
        const userRole = PulseChat.currentUser.role || 'user';
        const hasSpecialRole = ['admin', 'owner', 'developer'].includes(userRole);
        const displayTier = hasSpecialRole ? 3 : (PulseChat.currentUser.tier || 1);
        PulseChat.elements.profileTier.textContent = `Tier ${displayTier}`;
    }
    
    if (PulseChat.elements.profileRole) {
        const roleElement = PulseChat.elements.profileRole;
        const role = PulseChat.currentUser.role || 'user';
        roleElement.textContent = role.toUpperCase();
        roleElement.className = `role-badge ${role}`;
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
        benefitDiv.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${isAvailable ? 
                    '<polyline points="20,6 9,17 4,12"></polyline>' : 
                    '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'
                }
            </svg>
            <span>${benefit.text}</span>
        `;
        
        PulseChat.elements.tierBenefitsList.appendChild(benefitDiv);
    });
    
    // Add special role note if applicable
    if (hasSpecialRole) {
        const specialDiv = document.createElement('div');
        specialDiv.className = 'benefit-item available';
        specialDiv.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="13,2 3,14 12,14 11,22 21,10 12,10 13,2"></polygon>
            </svg>
            <span>All features unlocked (${userRole} privileges)</span>
        `;
        PulseChat.elements.tierBenefitsList.appendChild(specialDiv);
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
        friendDiv.setAttribute('data-friend-id', friend.friendId);
        
        // Check if this friend is currently selected
        if (PulseChat.selectedFriend && PulseChat.selectedFriend.friendId === friend.friendId) {
            friendDiv.classList.add('active');
        }
        
        const statusText = friend.inCall ? 'In call' : (friend.online ? 'Online' : 'Offline');
        
        friendDiv.innerHTML = `
            <div class="friend-item-info">
                <div class="friend-username">${escapeHtml(friend.friendUsername)}</div>
                <div class="friend-role">${friend.friendRole} • ${statusText}</div>
            </div>
        `;
        
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
    mobileBadge.textContent = PulseChat.friendRequests.length;
    mobileBadge.classList.remove('hidden');
    
    mobileRequestsList.innerHTML = '';
    
    PulseChat.friendRequests.forEach(request => {
        const requestDiv = document.createElement('div');
        requestDiv.className = 'friend-request-item';
        requestDiv.innerHTML = `
            <div class="friend-request-info">
                <span class="friend-request-username">${escapeHtml(request.senderUsername)}</span>
            </div>
            <div class="friend-request-buttons">
                <button class="friend-request-btn accept-btn" onclick="respondToFriendRequest('${request.id}', true)">
                    ✓ Accept
                </button>
                <button class="friend-request-btn deny-btn" onclick="respondToFriendRequest('${request.id}', false)">
                    ✗ Deny
                </button>
            </div>
        `;
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
    
    const statusText = friend.inCall ? 'In call' : (friend.online ? 'Online' : 'Offline');
    
    // Update mobile header elements
    PulseChat.elements.mobileHeaderAvatar.textContent = friend.friendUsername.charAt(0).toUpperCase();
    PulseChat.elements.mobileHeaderName.textContent = friend.friendUsername;
    PulseChat.elements.mobileHeaderStatus.textContent = statusText;
    
    // Show mobile header
    PulseChat.elements.mobileUserHeader.classList.remove('hidden');
}

function updateMobileUserInfo(friend) {
    if (!friend) return;
    
    // Update mobile user info modal
    PulseChat.elements.mobileUserAvatar.textContent = friend.friendUsername.charAt(0).toUpperCase();
    PulseChat.elements.mobileUserName.textContent = friend.friendUsername;
    
    const mobileRoleElement = PulseChat.elements.mobileUserRole;
    mobileRoleElement.textContent = friend.friendRole;
    mobileRoleElement.className = `role-badge ${friend.friendRole}`;
    
    // Update details
    const friendsSinceDate = new Date(friend.friendsSince).toLocaleDateString();
    PulseChat.elements.mobileFriendsSinceDate.textContent = friendsSinceDate;
    PulseChat.elements.mobileFriendTier.textContent = `Tier ${friend.friendTier}`;
    PulseChat.elements.mobileFriendRoleInfo.textContent = friend.friendRole.toUpperCase();
    
    // Show/hide call button based on friend status
    const mobileCallBtn = PulseChat.elements.mobileCallBtn;
    if (friend.inCall || PulseChat.currentCall) {
        mobileCallBtn.disabled = true;
        mobileCallBtn.textContent = friend.inCall ? 'Friend is in call' : 'You are in call';
    } else {
        mobileCallBtn.disabled = false;
        mobileCallBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
            </svg>
            Call Friend
        `;
    }
    
    // Show/hide admin actions
    const mobileAdminActions = PulseChat.elements.mobileAdminActions;
    if (isAdminOrOwner()) {
        mobileAdminActions.classList.remove('hidden');
    } else {
        mobileAdminActions.classList.add('hidden');
    }
}

// ===== Utility Functions =====

// Cookie management
function setCookie(name, value, days) {
    const expires = new Date();
    expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/`;
}

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
}

function deleteCookie(name) {
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:01 GMT;path=/`;
}

// HTML escaping
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Show notification
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <div style="font-weight: 500; margin-bottom: 4px;">${escapeHtml(message)}</div>
    `;
    
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
        element.textContent = message;
    }
}

function clearMessage(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
        element.innerHTML = '';
    }
}

// ===== Socket Event Handlers =====

// Authentication Events
PulseChat.socket.on('authenticated', (data) => {
    PulseChat.currentUser = data.user;
    hideModal(PulseChat.elements.loginModal);
    hideModal(PulseChat.elements.autoLoginIndicator);
    PulseChat.elements.mainApp.classList.remove('hidden');
    
    // Update user info display
    PulseChat.elements.currentUsername.textContent = PulseChat.currentUser.username;
    
    // Show role badge if applicable
    if (['admin', 'owner', 'developer'].includes(PulseChat.currentUser.role)) {
        const roleBadge = PulseChat.elements.userRole;
        roleBadge.textContent = PulseChat.currentUser.role;
        roleBadge.className = `role-badge ${PulseChat.currentUser.role}`;
        roleBadge.classList.remove('hidden');
    }
    
    // Update settings UI
    if (PulseChat.currentUser.settings) {
        PulseChat.elements.allowFriendRequests.checked = 
            PulseChat.currentUser.settings.allowFriendRequests !== false;
    }
    
    // Update profile tab if it's visible
    if (PulseChat.currentSettingsTab === 'profile') {
        updateProfileTab();
    }
});

PulseChat.socket.on('session_token', (token) => {
    setCookie('pulsechat_session', token, 30); // 30 days
});

PulseChat.socket.on('auth_error', (message) => {
    hideModal(PulseChat.elements.autoLoginIndicator);
    showMessage('authMessage', message, 'error');
    deleteCookie('pulsechat_session');
});

PulseChat.socket.on('banned', (data) => {
    alert(`You have been banned. Reason: ${data.reason}`);
    deleteCookie('pulsechat_session');
    location.reload();
});

PulseChat.socket.on('muted', (data) => {
    showNotification(`You have been muted for ${data.duration}. Reason: ${data.reason}`, 'error');
});

// Friends Events
PulseChat.socket.on('friends_list', (friendsList) => {
    PulseChat.friends = friendsList;
    renderFriendsList();
    renderMobileFriendsList();
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
    showNotification(`New friend request from ${request.senderUsername}!`, 'info');
});

PulseChat.socket.on('friend_request_accepted', (data) => {
    showNotification(`${data.username} accepted your friend request!`, 'success');
});

// WebRTC Call Events
PulseChat.socket.on('incoming_call', (data) => {
    if (PulseChat.currentCall) {
        // Already in a call, auto-decline
        PulseChat.socket.emit('decline_call', { callId: data.callId });
        return;
    }
    
    PulseChat.currentCall = {
        callId: data.callId,
        callerId: data.callerId,
        callerUsername: data.callerUsername,
        type: 'incoming'
    };
    
    showIncomingCallModal(data.callerUsername, data.callerId);
});

PulseChat.socket.on('call_initiated', (data) => {
    PulseChat.currentCall = {
        callId: data.callId,
        receiverId: data.receiverId,
        receiverUsername: data.receiverUsername,
        type: 'outgoing'
    };
    
    showActiveCallModal(data.receiverUsername, data.receiverId);
    updateCallStatus('ringing');
});

PulseChat.socket.on('call_accepted', (data) => {
    if (PulseChat.currentCall && PulseChat.currentCall.callId === data.callId) {
        updateCallStatus('connecting');
        
        // If we're the caller, create and send offer
        if (PulseChat.currentCall.type === 'outgoing') {
            createAndSendOffer();
        }
    }
});

PulseChat.socket.on('call_declined', (data) => {
    showNotification('Call was declined', 'info');
    endCurrentCall();
});

PulseChat.socket.on('call_ended', (data) => {
    showNotification(data.reason || 'Call ended', 'info');
    endCurrentCall();
});

PulseChat.socket.on('webrtc_offer', async (data) => {
    if (PulseChat.currentCall && PulseChat.currentCall.callId === data.callId) {
        try {
            await PulseChat.peerConnection.setRemoteDescription(data.offer);
            const answer = await PulseChat.peerConnection.createAnswer();
            await PulseChat.peerConnection.setLocalDescription(answer);
            
            PulseChat.socket.emit('webrtc_answer', {
                callId: data.callId,
                answer: answer
            });
        } catch (error) {
            console.error('Error handling WebRTC offer:', error);
            hangUpCall();
        }
    }
});

PulseChat.socket.on('webrtc_answer', async (data) => {
    if (PulseChat.currentCall && PulseChat.currentCall.callId === data.callId) {
        try {
            await PulseChat.peerConnection.setRemoteDescription(data.answer);
        } catch (error) {
            console.error('Error handling WebRTC answer:', error);
            hangUpCall();
        }
    }
});

PulseChat.socket.on('webrtc_ice_candidate', async (data) => {
    if (PulseChat.currentCall && PulseChat.currentCall.callId === data.callId) {
        try {
            await PulseChat.peerConnection.addIceCandidate(data.candidate);
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }
});

PulseChat.socket.on('call_error', (message) => {
    showNotification(message, 'error');
    endCurrentCall();
});

async function createAndSendOffer() {
    try {
        const offer = await PulseChat.peerConnection.createOffer();
        await PulseChat.peerConnection.setLocalDescription(offer);
        
        PulseChat.socket.emit('webrtc_offer', {
            callId: PulseChat.currentCall.callId,
            offer: offer
        });
    } catch (error) {
        console.error('Error creating WebRTC offer:', error);
        hangUpCall();
    }
}

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
});

PulseChat.socket.on('message_sent', (message) => {
    PulseChat.messages.push(message);
    addMessageToChat(message);
});

PulseChat.socket.on('message_deleted', (data) => {
    // Remove from local messages array first
    PulseChat.messages = PulseChat.messages.filter(m => m.id !== data.messageId);
    
    // Find and remove the message element
    const messageElement = document.querySelector(`[data-message-id="${data.messageId}"]`);
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
        // End call if one is active with this user
        if (PulseChat.currentCall) {
            endCurrentCall();
        }
        
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
        PulseChat.elements.chatTitle.textContent = 'Select a friend to start chatting';
        disableInputs();
    }
});

PulseChat.socket.on('user_unblocked', (data) => {
    showNotification('User unblocked successfully!', 'success');
});

PulseChat.socket.on('user_muted', (data) => {
    showNotification(`User muted successfully for ${data.duration}!`, 'success');
});

PulseChat.socket.on('user_banned', (data) => {
    showNotification('User banned successfully!', 'success');
    closeBanModal();
});

// Settings Events
PulseChat.socket.on('settings_updated', (settings) => {
    showMessage('settingsMessage', 'Settings saved successfully!', 'success');
    if (PulseChat.currentUser.settings) {
        PulseChat.currentUser.settings = { ...PulseChat.currentUser.settings, ...settings };
    } else {
        PulseChat.currentUser.settings = settings;
    }
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

// ===== Authentication Functions =====

function login() {
    const username = PulseChat.elements.username.value.trim();
    const password = PulseChat.elements.password.value.trim();
    
    if (!username || !password) {
        showMessage('authMessage', 'Please enter username and password', 'error');
        return;
    }
    
    PulseChat.socket.emit('authenticate', { username, password });
}

function register() {
    const username = PulseChat.elements.regUsername.value.trim();
    const password = PulseChat.elements.regPassword.value.trim();
    
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
    // End any active call before logging out
    if (PulseChat.currentCall) {
        endCurrentCall();
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
    const username = PulseChat.elements.friendUsername.value.trim();
    
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
    badge.textContent = PulseChat.friendRequests.length;
    badge.classList.remove('hidden');
    
    requestsList.innerHTML = '';
    
    PulseChat.friendRequests.forEach(request => {
        const requestDiv = document.createElement('div');
        requestDiv.className = 'friend-request-item';
        requestDiv.innerHTML = `
            <div class="friend-request-info">
                <span class="friend-request-username">${escapeHtml(request.senderUsername)}</span>
            </div>
            <div class="friend-request-buttons">
                <button class="friend-request-btn accept-btn" onclick="respondToFriendRequest('${request.id}', true)">
                    ✓ Accept
                </button>
                <button class="friend-request-btn deny-btn" onclick="respondToFriendRequest('${request.id}', false)">
                    ✗ Deny
                </button>
            </div>
        `;
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
        blockedDiv.innerHTML = `
            <span class="blocked-username">${escapeHtml(blocked.blockedUsername)}</span>
            <button class="unblock-btn" onclick="unblockUser('${blocked.blockedId}')">
                Unblock
            </button>
        `;
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
        friendDiv.setAttribute('data-friend-id', friend.friendId);
        
        // Check if this friend is currently selected
        if (PulseChat.selectedFriend && PulseChat.selectedFriend.friendId === friend.friendId) {
            friendDiv.classList.add('active');
        }
        
        const statusText = friend.inCall ? 'In call' : (friend.online ? 'Online' : 'Offline');
        
        friendDiv.innerHTML = `
            <div class="friend-item-info">
                <div class="friend-username">${escapeHtml(friend.friendUsername)}</div>
                <div class="friend-role">${friend.friendRole} • ${statusText}</div>
            </div>
        `;
        
        friendDiv.onclick = () => selectFriend(friend);
        friendsList.appendChild(friendDiv);
    });
}

function respondToFriendRequest(requestId, accept) {
    PulseChat.socket.emit('respond_friend_request', { requestId, accept });
}

function unblockUser(userId) {
    PulseChat.socket.emit('unblock_user', { userId });
    
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
    const desktopFriendElement = PulseChat.elements.friendsList.querySelector(`[data-friend-id="${friend.friendId}"]`);
    const mobileFriendElement = PulseChat.elements.mobileFriendsList.querySelector(`[data-friend-id="${friend.friendId}"]`);
    
    if (desktopFriendElement) {
        desktopFriendElement.classList.add('active');
    }
    if (mobileFriendElement) {
        mobileFriendElement.classList.add('active');
    }
    
    // Update desktop title
    PulseChat.elements.chatTitle.textContent = `Chat with ${friend.friendUsername}`;
    
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
    // Update desktop avatar (first letter of username)
    const avatar = PulseChat.elements.friendAvatar;
    avatar.textContent = friend.friendUsername.charAt(0).toUpperCase();
    
    // Update desktop info
    PulseChat.elements.friendInfoUsername.textContent = friend.friendUsername;
    
    const roleElement = PulseChat.elements.friendInfoRole;
    roleElement.textContent = friend.friendRole;
    roleElement.className = `role-badge ${friend.friendRole}`;
    
    // Update desktop details
    const friendsSinceDate = new Date(friend.friendsSince).toLocaleDateString();
    PulseChat.elements.friendsSinceDate.textContent = friendsSinceDate;
    PulseChat.elements.friendTier.textContent = `Tier ${friend.friendTier}`;
    PulseChat.elements.friendRoleInfo.textContent = friend.friendRole.toUpperCase();
    
    // Show/hide call button based on friend and current call status
    const callBtn = PulseChat.elements.callBtn;
    if (friend.inCall || PulseChat.currentCall) {
        callBtn.disabled = true;
        callBtn.textContent = friend.inCall ? 'Friend is in call' : 'You are in call';
    } else {
        callBtn.disabled = false;
        callBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
            </svg>
            Call Friend
        `;
    }
    
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
    const content = input.value.trim();
    
    if (!content) return;
    
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
    messageDiv.setAttribute('data-message-id', message.id);
    
    const timestamp = new Date(message.timestamp).toLocaleTimeString();
    const senderName = message.senderId === PulseChat.currentUser.id ? 'You' : PulseChat.selectedFriend.friendUsername;
    
    // Check if user can delete this message
    const canDelete = message.senderId === PulseChat.currentUser.id || isAdminOrOwner();
    
    const actionsHtml = canDelete ? `
        <div class="message-actions">
            <button class="message-action-btn delete-btn" onclick="deleteMessage('${message.id}')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3,6 5,6 21,6"></polyline>
                    <path d="M19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2V6"></path>
                </svg>
            </button>
        </div>
    ` : '';
    
    if (message.type === 'text') {
        messageDiv.innerHTML = `
            <div class="message-header">${senderName} • ${timestamp}</div>
            <div class="message-content">${escapeHtml(message.content)}</div>
            ${actionsHtml}
        `;
    } else if (message.type === 'image') {
        messageDiv.innerHTML = `
            <div class="message-header">${senderName} • ${timestamp}</div>
            <div class="message-content">
                <img src="/api/media/${message.content}" alt="Shared image" loading="lazy">
            </div>
            ${actionsHtml}
        `;
    } else if (message.type === 'video') {
        messageDiv.innerHTML = `
            <div class="message-header">${senderName} • ${timestamp}</div>
            <div class="message-content">
                <video controls preload="metadata">
                    <source src="/api/media/${message.content}" type="video/mp4">
                    <source src="/api/media/${message.content}" type="video/webm">
                    Your browser does not support the video tag.
                </source>
            </div>
            ${actionsHtml}
        `;
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
    
    PulseChat.socket.emit('delete_message', { messageId });
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
    
    const reason = PulseChat.elements.banReason.value.trim();
    PulseChat.socket.emit('admin_ban_user', { userId: PulseChat.userToBan, reason });
}

// ===== Settings =====

function showSettings() {
    showModal(PulseChat.elements.settingsModal);
    
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
    
    PulseChat.socket.emit('update_settings', { allowFriendRequests });
}

// ===== Event Listeners =====

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
        if (modal.classList.contains('call-modal')) {
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

// Handle page unload to cleanup WebRTC
window.addEventListener('beforeunload', function() {
    if (PulseChat.currentCall) {
        cleanupWebRTC();
    }
});

// ===== Initialization =====

window.addEventListener('load', () => {
    checkAutoLogin();
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

// WebRTC call functions
window.initiateCall = initiateCall;
window.acceptCall = acceptCall;
window.declineCall = declineCall;
window.hangUpCall = hangUpCall;
window.toggleMute = toggleMute;